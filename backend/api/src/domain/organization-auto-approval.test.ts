import { describe, expect, it, vi } from "vitest";
import { evaluateOrganizationAutoApproval } from "./organization-auto-approval.js";

describe("organization auto approval", () => {
  it("保存されたversionと直近件数を使って評価する", async () => {
    const tx = {
      organization_auto_approval_policies: {
        findUnique: vi.fn(async () => ({
          id: "policy-1",
          version: 4,
          emergency_stopped_at: null,
          config: {
            mode: "all_within_policy",
            environments: ["production"],
            allowed_hosts: ["api.company.example"],
            allowed_operations: ["lookup_contract"],
            allowed_methods: ["GET"],
            denied_methods: ["DELETE"],
            limits: { requests_per_minute: 100, daily_cost_jpy: null, max_records_per_call: 100 },
            production_promotion: true,
            automatic_retry: true,
            automatic_rollback: true,
            expires_at: null,
          },
        })),
      },
      approvals: { count: vi.fn(async () => 7) },
    };
    const result = await evaluateOrganizationAutoApproval(tx as never, "org-1", {
      actionKind: "api_call",
      stage: "production",
      operation: "lookup_contract",
      risk: "read",
      host: "api.company.example",
      method: "GET",
      requestedRecords: 1,
      now: new Date("2026-09-22T00:00:00Z"),
    });
    expect(result).toMatchObject({ policy: { id: "policy-1", version: 4 }, decision: { action: "auto_approve" } });
    expect(tx.approvals.count).toHaveBeenCalledOnce();
  });
});
