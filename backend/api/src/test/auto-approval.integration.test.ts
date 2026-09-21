import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

describe("organization auto approval policy", () => {
  let h: Harness;
  let owner: { email: string; org: string };

  beforeAll(async () => {
    h = createHarness();
    const email = `auto-approval-${h.suffix}@example.com`;
    const org = await h.createOrg("auto-approval", [{ email, role: "owner", approver: true }]);
    owner = { email, org: org.id };
  });

  afterAll(async () => h.close());

  it("version履歴を残し、緊急停止と再開を監査する", async () => {
    const initial = await h.request("GET", "/api/v1/organization/auto-approval-policy", owner);
    expect(initial.body).toMatchObject({ id: null, version: 0, config: { mode: "manual" } });

    const config = {
      mode: "all_within_policy",
      environments: ["staging", "production"],
      allowed_hosts: ["api.company.example"],
      allowed_operations: ["lookup_contract"],
      allowed_methods: ["GET"],
      denied_methods: ["DELETE"],
      limits: { requests_per_minute: 100, daily_cost_jpy: null, max_records_per_call: 100 },
      production_promotion: true,
      automatic_retry: true,
      automatic_rollback: true,
      expires_at: null,
    };
    const first = await h.request("PUT", "/api/v1/organization/auto-approval-policy", { ...owner, body: config });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ version: 1, config: { mode: "all_within_policy", allowed_hosts: ["api.company.example"] } });

    const second = await h.request("PUT", "/api/v1/organization/auto-approval-policy", {
      ...owner,
      body: { ...config, allowed_operations: ["lookup_contract", "update_contract_status"], allowed_methods: ["GET", "PATCH"] },
    });
    expect(second.body.version).toBe(2);
    expect(await h.admin.organization_auto_approval_policy_versions.count({ where: { organization_id: owner.org } })).toBe(2);

    const stopped = await h.request("POST", "/api/v1/organization/auto-approval-policy/emergency-stop", { ...owner, body: { stopped: true } });
    expect(stopped.body.emergency_stopped_at).not.toBeNull();
    const resumed = await h.request("POST", "/api/v1/organization/auto-approval-policy/emergency-stop", { ...owner, body: { stopped: false } });
    expect(resumed.body.emergency_stopped_at).toBeNull();

    const actions = await h.admin.audit_logs.findMany({ where: { organization_id: owner.org, action: { startsWith: "auto_approval_policy." } } });
    expect(actions.map((entry) => entry.action)).toEqual(expect.arrayContaining([
      "auto_approval_policy.update",
      "auto_approval_policy.emergency_stop",
      "auto_approval_policy.resume",
    ]));
  });
});
