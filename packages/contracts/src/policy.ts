import { z } from "zod";
import { toolNameSchema } from "./common.js";

/**
 * ポリシーの条件式。自由記述の式は評価の安全性を保証しにくいため、
 * 構造化した比較だけを許可する。
 */
const fieldPathSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/, "引数名の形式が正しくありません");

const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);

export const comparisonSchema = z
  .object({
    field: fieldPathSchema,
    op: z.enum([">", ">=", "<", "<=", "==", "!=", "in", "not_in"]),
    value: z.union([scalarSchema, z.array(z.union([z.string(), z.number()]))]),
    /** 数値比較の前に絶対値を取る（値下げ・値上げを同じ条件で扱うため） */
    abs: z.boolean().optional(),
  })
  .strict();
export type Comparison = z.infer<typeof comparisonSchema>;

export const conditionSchema = z.union([
  comparisonSchema,
  z.object({ all: z.array(comparisonSchema).min(1).max(16) }).strict(),
  z.object({ any: z.array(comparisonSchema).min(1).max(16) }).strict(),
]);
export type Condition = z.infer<typeof conditionSchema>;

/** "*" は全ツールを対象にする */
const policyToolSchema = z.union([toolNameSchema, z.literal("*")]);

export const policySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("approval"),
      tool: policyToolSchema,
      when: conditionSchema.optional(),
      /** 承認待ちの期限（分）。期限を過ぎると却下扱い */
      timeout_minutes: z.number().int().min(1).max(10080).default(1440),
      reason: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("deny"),
      tool: policyToolSchema,
      when: conditionSchema.optional(),
      reason: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("rate_limit"),
      tool: policyToolSchema,
      max_calls_per_session: z.number().int().min(1).max(10000),
    })
    .strict(),
  z
    .object({
      type: z.literal("time_window"),
      tool: policyToolSchema,
      timezone: z.string().default("Asia/Tokyo"),
      start_hour: z.number().int().min(0).max(23),
      end_hour: z.number().int().min(1).max(24),
      weekdays_only: z.boolean().default(false),
    })
    .strict(),
]);
export type Policy = z.infer<typeof policySchema>;
export type PolicyInput = z.input<typeof policySchema>;

export type PolicyDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "require_approval"; reason: string; timeout_minutes: number };

export interface ToolCallContext {
  tool: string;
  args: Record<string, unknown>;
  now: Date;
  /** このセッションで、このツールをすでに呼んだ回数（今回を含まない） */
  callsSoFar: number;
}

type Tri = "true" | "false" | "unknown";

function resolveField(args: Record<string, unknown>, path: string): unknown {
  let cur: unknown = args;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function evalComparison(c: Comparison, args: Record<string, unknown>): Tri {
  const raw = resolveField(args, c.field);
  if (raw === undefined) return "unknown";

  switch (c.op) {
    case ">":
    case ">=":
    case "<":
    case "<=": {
      let left = toNumber(raw);
      const right = toNumber(c.value);
      if (left === undefined || right === undefined) return "unknown";
      if (c.abs) left = Math.abs(left);
      const r =
        c.op === ">" ? left > right : c.op === ">=" ? left >= right : c.op === "<" ? left < right : left <= right;
      return r ? "true" : "false";
    }
    case "==":
    case "!=": {
      const ln = toNumber(raw);
      const rn = toNumber(c.value);
      const eq =
        ln !== undefined && rn !== undefined
          ? (c.abs ? Math.abs(ln) : ln) === rn
          : String(raw) === String(c.value);
      return (c.op === "==" ? eq : !eq) ? "true" : "false";
    }
    case "in":
    case "not_in": {
      if (!Array.isArray(c.value)) return "unknown";
      const hit = c.value.some((v) => String(v) === String(raw));
      return (c.op === "in" ? hit : !hit) ? "true" : "false";
    }
  }
}

/**
 * 条件を評価する。引数が無い・数値にできないなど判定できない場合は
 * 「条件に当てはまる」とみなす（安全側に倒す）。
 */
export function conditionMatches(cond: Condition | undefined, args: Record<string, unknown>): boolean {
  if (!cond) return true;
  if ("all" in cond) return cond.all.every((c) => evalComparison(c, args) !== "false");
  if ("any" in cond) return cond.any.some((c) => evalComparison(c, args) !== "false");
  return evalComparison(cond, args) !== "false";
}

function appliesTo(policyTool: string, tool: string): boolean {
  return policyTool === "*" || policyTool === tool;
}

function hourInTimezone(now: Date, timezone: string): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
  return { hour, weekday };
}

/**
 * ツール呼び出しに対するポリシー判定。
 * 複数のポリシー（組織・Agent・Runtime 側）を連結して渡せば、最も厳しい結果になる。
 * 優先順位: 拒否 > 承認が必要 > 許可
 */
export function evaluatePolicies(policies: readonly Policy[], call: ToolCallContext): PolicyDecision {
  const approvals: { reason: string; timeout: number }[] = [];

  for (const p of policies) {
    if (!appliesTo(p.tool, call.tool)) continue;

    switch (p.type) {
      case "deny":
        if (conditionMatches(p.when, call.args)) {
          return { action: "deny", reason: p.reason ?? `ポリシーにより ${call.tool} の実行は禁止されています` };
        }
        break;
      case "rate_limit":
        if (call.callsSoFar >= p.max_calls_per_session) {
          return {
            action: "deny",
            reason: `${call.tool} は1回の実行につき${p.max_calls_per_session}回までです`,
          };
        }
        break;
      case "time_window": {
        const { hour, weekday } = hourInTimezone(call.now, p.timezone);
        const inHours = p.start_hour <= p.end_hour ? hour >= p.start_hour && hour < p.end_hour : hour >= p.start_hour || hour < p.end_hour;
        const inDays = !p.weekdays_only || (weekday >= 1 && weekday <= 5);
        if (!inHours || !inDays) {
          return {
            action: "deny",
            reason: `${call.tool} は${p.weekdays_only ? "平日の" : ""}${p.start_hour}時〜${p.end_hour}時（${p.timezone}）にだけ実行できます`,
          };
        }
        break;
      }
      case "approval":
        if (conditionMatches(p.when, call.args)) {
          approvals.push({
            reason: p.reason ?? `${call.tool} の実行には承認が必要です`,
            timeout: p.timeout_minutes,
          });
        }
        break;
    }
  }

  if (approvals.length > 0) {
    return {
      action: "require_approval",
      reason: approvals.map((a) => a.reason).join(" / "),
      timeout_minutes: Math.min(...approvals.map((a) => a.timeout)),
    };
  }
  return { action: "allow" };
}
