import { describe, expect, it } from "vitest";
import { autoApprovalPolicyConfigSchema, evaluateAutoApproval, requestedRecordCount } from "./auto-approval.js";

const policy = autoApprovalPolicyConfigSchema.parse({
  mode: "all_within_policy",
  environments: ["staging", "production"],
  allowed_hosts: ["api.company.example"],
  allowed_operations: ["lookup_contract", "update_contract_status"],
  allowed_methods: ["GET", "PATCH"],
  denied_methods: ["DELETE"],
  limits: { requests_per_minute: 100, daily_cost_jpy: null, max_records_per_call: 100 },
  production_promotion: true,
  automatic_retry: true,
  automatic_rollback: true,
  expires_at: null,
});

describe("auto approval", () => {
  it("事前許可した範囲だけを自動承認する", () => {
    expect(evaluateAutoApproval(policy, {
      actionKind: "api_call",
      stage: "production",
      operation: "update_contract_status",
      risk: "write",
      host: "api.company.example",
      method: "PATCH",
      callsLastMinute: 3,
      requestedRecords: 1,
      now: new Date("2026-09-22T00:00:00Z"),
    }).action).toBe("auto_approve");
  });

  it.each([
    [{ operation: "delete_contract" }, "許可済み操作"],
    [{ host: "other.example" }, "許可済みhost"],
    [{ method: "DELETE" as const }, "常に手動承認"],
    [{ callsLastMinute: 100 }, "1分あたり"],
    [{ requestedRecords: 101 }, "最大件数"],
  ])("Policy外はfail closedにする", (override, message) => {
    const result = evaluateAutoApproval(policy, {
      actionKind: "api_call",
      stage: "production",
      operation: "update_contract_status",
      risk: "write",
      host: "api.company.example",
      method: "PATCH",
      callsLastMinute: 3,
      requestedRecords: 1,
      now: new Date("2026-09-22T00:00:00Z"),
      ...override,
    });
    expect(result).toMatchObject({ action: "manual_required", reason: expect.stringContaining(message) });
  });

  it("safe_operationsは書き込みを自動承認しない", () => {
    const safe = { ...policy, mode: "safe_operations" as const };
    expect(evaluateAutoApproval(safe, {
      actionKind: "api_call",
      stage: "staging",
      operation: "update_contract_status",
      risk: "write",
      host: "api.company.example",
      method: "PATCH",
      callsLastMinute: 0,
      now: new Date("2026-09-22T00:00:00Z"),
    }).action).toBe("manual_required");
  });

  it("件数引数を決定的に抽出する", () => {
    expect(requestedRecordCount({ page_size: 25 })).toBe(25);
    expect(requestedRecordCount({ query: "x" })).toBeNull();
  });

  it.each([
    ["production_promotion" as const, { production_promotion: false }, "Production自動昇格"],
    ["retry" as const, { automatic_retry: false }, "自動再試行"],
    ["rollback" as const, { automatic_rollback: false }, "自動Rollback"],
  ])("%sは専用flagも必要とする", (actionKind, override, message) => {
    const result = evaluateAutoApproval({ ...policy, allowed_operations: [actionKind], ...override }, {
      actionKind,
      stage: "production",
      operation: actionKind,
      risk: "write",
      callsLastMinute: 0,
      now: new Date("2026-09-22T00:00:00Z"),
    });
    expect(result).toMatchObject({ action: "manual_required", reason: expect.stringContaining(message) });
  });

  it("非HTTP操作にはhostとmethodを要求しない", () => {
    expect(evaluateAutoApproval({ ...policy, allowed_operations: ["production_promotion"] }, {
      actionKind: "production_promotion",
      stage: "production",
      operation: "production_promotion",
      risk: "write",
      callsLastMinute: 0,
      now: new Date("2026-09-22T00:00:00Z"),
    }).action).toBe("auto_approve");
  });

  it("完全自律運転は登録済み能力のallowlist、risk、DELETE、Production flagを包括承認する", () => {
    const autonomous = autoApprovalPolicyConfigSchema.parse({
      ...policy,
      mode: "full_autonomy",
      environments: ["staging"],
      allowed_hosts: [],
      allowed_operations: [],
      allowed_methods: [],
      denied_methods: ["DELETE"],
      production_promotion: false,
    });
    expect(evaluateAutoApproval(autonomous, {
      actionKind: "api_call",
      stage: "production",
      operation: "delete_contract",
      risk: "destructive",
      host: "newly-registered.company.example",
      method: "DELETE",
      callsLastMinute: 0,
      now: new Date("2026-09-22T00:00:00Z"),
    })).toMatchObject({ action: "auto_approve", reason: expect.stringContaining("完全自律Policy") });
  });

  it("完全自律運転でも緊急停止と利用上限は越えない", () => {
    const autonomous = autoApprovalPolicyConfigSchema.parse({ ...policy, mode: "full_autonomy", allowed_operations: [] });
    const context = {
      actionKind: "tool_call" as const,
      stage: "production" as const,
      operation: "anything",
      risk: "financial" as const,
      callsLastMinute: 0,
      now: new Date("2026-09-22T00:00:00Z"),
    };
    expect(evaluateAutoApproval(autonomous, { ...context, emergencyStoppedAt: context.now }).action).toBe("manual_required");
    expect(evaluateAutoApproval(autonomous, { ...context, callsLastMinute: 100 }).action).toBe("manual_required");
  });
});
