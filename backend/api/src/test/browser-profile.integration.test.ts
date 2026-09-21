import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

const identity = (account: string, role: string) => ({ method: "POST", url: `dev://${account}/${role}`, headers: {}, body: "" });

describe("Browser Profile / Human Login metadata boundary", () => {
  let h: Harness;
  let owner: { email: string; org: string };
  let runtimeId: string;
  let runtimeToken: string;

  beforeAll(async () => {
    h = createHarness();
    const email = `browser-profile-${h.suffix}@example.com`;
    const org = await h.createOrg("browser-profile", [{ email, role: "owner", approver: true }]);
    owner = { email, org: org.id };
    const account = `8${h.suffix.replace(/[^0-9]/g, "").padEnd(11, "1").slice(0, 11)}`;
    const role = `browser-profile-${h.suffix}`;
    const runtime = await h.request("POST", "/api/v1/runtimes", { ...owner, body: {
      name: "Browser Runtime", stage: "staging", provisioning_type: "studio_managed",
      aws_account_id: account, aws_region: "ap-northeast-1", expected_role_name: role,
    } });
    runtimeId = runtime.body.id;
    const bootstrap = await h.request("POST", `/api/v1/runtimes/${runtimeId}/bootstrap-tokens`, owner);
    const registered = await h.request("POST", "/runtime/v1/register", { body: {
      bootstrap_token: bootstrap.body.token, identity: identity(account, role), controller_version: "test",
    } });
    runtimeToken = registered.body.access_token;
    await h.request("POST", "/runtime/v1/heartbeat", { token: runtimeToken, body: {
      controller_version: "test", gateway_url: "http://gateway.browser.internal:8080/mcp", active_sessions: [], tools: [],
    } });
  });

  afterAll(async () => h.close());

  it("keeps credentials out of Control Plane and activates only from a matching Runtime result", async () => {
    const profile = await h.request("POST", "/api/v1/browser-profiles", { ...owner, body: {
      runtime_id: runtimeId, provider_key: "example", display_name: "Example Login", environment: "staging",
      allowed_domains: ["example.com"],
    } });
    expect(profile.status).toBe(201);
    expect(JSON.stringify(profile.body)).not.toMatch(/cookie|password|relay_token/i);

    const login = await h.request("POST", `/api/v1/browser-profiles/${profile.body.id}/login-sessions`, owner);
    expect(login.status).toBe(201);
    expect(login.body).toMatchObject({ profile_id: profile.body.id, status: "running", launch_path: expect.any(String) });
    expect(JSON.stringify(login.body)).not.toMatch(/relay_token_hash|cookie|password/i);

    const leased = await h.request("GET", "/runtime/v1/jobs/next?wait=0", { token: runtimeToken });
    expect(leased.body.job).toMatchObject({ type: "start_browser_login", login_session_id: login.body.id, profile_id: profile.body.id });
    const result = await h.request("POST", `/runtime/v1/jobs/${leased.body.job.job_id}/result`, { token: runtimeToken, body: {
      status: "succeeded",
      output: {
        login_session_id: login.body.id, profile_id: profile.body.id,
        runtime_object_key: `profiles/${profile.body.id}/storage-state.enc`,
        verified_domains: ["example.com"], expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      },
    } });
    expect(result.status).toBe(204);
    const profiles = await h.request("GET", "/api/v1/browser-profiles", owner);
    expect(profiles.body).toEqual([expect.objectContaining({ id: profile.body.id, status: "active", allowed_domains: ["example.com"] })]);
    expect(JSON.stringify(profiles.body)).not.toContain("runtime_object_key");
  });
});
