import { z } from "zod";
import { toolNameSchema } from "./common.js";
import { toolRiskSchema } from "./tools.js";

export const autoApprovalModeSchema = z.enum(["manual", "safe_operations", "all_within_policy"]);
export type AutoApprovalMode = z.infer<typeof autoApprovalModeSchema>;

const exactHostnameSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .transform((value) => value.toLowerCase().replace(/\.$/, ""))
  .refine((value) => !value.includes("*") && !value.includes(":") && !value.includes("/"), "hostは完全一致するFQDNで指定してください");

export const autoApprovalPolicyConfigSchema = z
  .object({
    mode: autoApprovalModeSchema.default("manual"),
    environments: z.array(z.enum(["staging", "production"])).max(2).default(["staging"]),
    allowed_hosts: z.array(exactHostnameSchema).max(100).default([]),
    allowed_operations: z.array(toolNameSchema).max(500).default([]),
    allowed_methods: z.array(z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"])).max(5).default(["GET"]),
    denied_methods: z.array(z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"])).max(5).default(["DELETE"]),
    limits: z
      .object({
        requests_per_minute: z.number().int().min(1).max(10_000).default(100),
        daily_cost_jpy: z.number().int().positive().max(100_000_000).nullable().default(null),
        max_records_per_call: z.number().int().min(1).max(100_000).default(100),
      })
      .strict()
      .default({ requests_per_minute: 100, daily_cost_jpy: null, max_records_per_call: 100 }),
    production_promotion: z.boolean().default(false),
    automatic_retry: z.boolean().default(true),
    automatic_rollback: z.boolean().default(true),
    expires_at: z.iso.datetime().nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    const denied = new Set(value.denied_methods);
    for (const method of value.allowed_methods) {
      if (denied.has(method)) ctx.addIssue({ code: "custom", path: ["allowed_methods"], message: `${method}は拒否リストにも含まれています` });
    }
    if (value.mode !== "manual" && value.allowed_operations.length === 0) {
      ctx.addIssue({ code: "custom", path: ["allowed_operations"], message: "自動承認する操作を1つ以上指定してください" });
    }
  });

export type AutoApprovalPolicyConfig = z.infer<typeof autoApprovalPolicyConfigSchema>;
export type UpdateAutoApprovalPolicyInput = z.input<typeof autoApprovalPolicyConfigSchema>;
export const setAutoApprovalEmergencyStopSchema = z.object({ stopped: z.boolean() }).strict();
export type SetAutoApprovalEmergencyStopInput = z.infer<typeof setAutoApprovalEmergencyStopSchema>;

export interface AutoApprovalPolicyDto {
  id: string | null;
  version: number;
  config: AutoApprovalPolicyConfig;
  emergency_stopped_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface AutoApprovalContext {
  actionKind: "api_call" | "tool_call" | "preview_run" | "production_promotion" | "pull_request_create" | "pull_request_merge" | "adapter_distribution" | "runtime_registration" | "retry" | "rollback";
  stage: "staging" | "production";
  operation: string;
  risk: z.infer<typeof toolRiskSchema>;
  host?: string | null;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | null;
  requestedRecords?: number | null;
  callsLastMinute: number;
  estimatedDailyCostJpy?: number | null;
  now: Date;
  emergencyStoppedAt?: Date | null;
}

export type AutoApprovalDecision =
  | { action: "auto_approve"; reason: string }
  | { action: "manual_required"; reason: string };

/**
 * 「すべて自動」は無条件承認ではない。完全一致のPolicy内だけを許可し、
 * 判定材料が欠ける場合は必ず手動承認へフォールバックする。
 */
export function evaluateAutoApproval(policy: AutoApprovalPolicyConfig, context: AutoApprovalContext): AutoApprovalDecision {
  if (policy.mode === "manual") return { action: "manual_required", reason: "組織Policyは個別承認モードです" };
  if (context.emergencyStoppedAt) return { action: "manual_required", reason: "自動承認は緊急停止中です" };
  if (policy.expires_at && Date.parse(policy.expires_at) <= context.now.getTime()) {
    return { action: "manual_required", reason: "自動承認Policyの有効期限が切れています" };
  }
  if (!policy.environments.includes(context.stage)) {
    return { action: "manual_required", reason: `${context.stage}は自動承認対象ではありません` };
  }
  if (context.actionKind === "production_promotion" && !policy.production_promotion) {
    return { action: "manual_required", reason: "Production自動昇格が許可されていません" };
  }
  if (context.actionKind === "retry" && !policy.automatic_retry) {
    return { action: "manual_required", reason: "自動再試行が許可されていません" };
  }
  if (context.actionKind === "rollback" && !policy.automatic_rollback) {
    return { action: "manual_required", reason: "自動Rollbackが許可されていません" };
  }
  if (!policy.allowed_operations.includes(context.operation)) {
    return { action: "manual_required", reason: `${context.operation}は許可済み操作ではありません` };
  }
  if (policy.mode === "safe_operations" && context.risk !== "read") {
    return { action: "manual_required", reason: "安全操作モードでは読み取り操作だけを自動承認します" };
  }
  if (context.actionKind === "api_call" && !context.method) {
    return { action: "manual_required", reason: "接続先のHTTP methodを確認できません" };
  }
  if (context.actionKind === "api_call" && !context.host) {
    return { action: "manual_required", reason: "接続先hostを確認できません" };
  }
  if (context.method) {
    if (policy.denied_methods.includes(context.method)) return { action: "manual_required", reason: `${context.method}は常に手動承認です` };
    if (!policy.allowed_methods.includes(context.method)) return { action: "manual_required", reason: `${context.method}は許可済みmethodではありません` };
  }
  if (context.host) {
    const host = context.host.toLowerCase().replace(/\.$/, "");
    if (!policy.allowed_hosts.includes(host)) return { action: "manual_required", reason: `${host}は許可済みhostではありません` };
  }
  if (context.callsLastMinute >= policy.limits.requests_per_minute) {
    return { action: "manual_required", reason: "1分あたりの自動承認上限に達しました" };
  }
  if (context.requestedRecords !== null && context.requestedRecords !== undefined && context.requestedRecords > policy.limits.max_records_per_call) {
    return { action: "manual_required", reason: "1回あたりの最大件数を超えています" };
  }
  if (policy.limits.daily_cost_jpy !== null) {
    if (context.estimatedDailyCostJpy === null || context.estimatedDailyCostJpy === undefined) {
      return { action: "manual_required", reason: "費用上限を評価する情報がありません" };
    }
    if (context.estimatedDailyCostJpy > policy.limits.daily_cost_jpy) {
      return { action: "manual_required", reason: "1日あたりの費用上限を超えています" };
    }
  }
  return {
    action: "auto_approve",
    reason: `組織Policy内: ${context.stage} / ${context.operation}${context.method ? ` / ${context.method}` : ""}${context.host ? ` / ${context.host}` : ""}`,
  };
}

export function requestedRecordCount(args: Record<string, unknown>): number | null {
  for (const key of ["limit", "page_size", "pageSize", "max_records", "maxRecords"]) {
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  }
  return null;
}
