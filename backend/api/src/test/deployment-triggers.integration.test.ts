import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

describe("Production Deployment triggers", () => {
  let h: Harness;
  let owner: { email: string; org: string };
  let deploymentId: string;

  beforeAll(async () => {
    h = createHarness();
    const email = `trigger-owner-${h.suffix}@example.com`;
    const org = await h.createOrg("trigger", [{ email, role: "owner", approver: true }]);
    owner = { email, org: org.id };
    const profile = await h.request("POST", "/api/v1/environments", {
      ...owner,
      body: { type: "openai_hosted", key: "trigger-openai", name: "Trigger OpenAI", template: "general-python", network: { mode: "disabled" } },
    });
    const agent = await h.request("POST", "/api/v1/agents", { ...owner, body: { manifest: "agent:\n  key: trigger-agent\n  name: Trigger Agent\ninstructions: 入力へ回答する\n" } });
    const version = await h.request("POST", `/api/v1/agents/${agent.body.id}/versions/1/publish`, owner);
    const deployment = await h.request("POST", "/api/v1/deployments", { ...owner, body: { agent_version_id: version.body.id, runtime_profile_id: profile.body.id, stage: "production" } });
    expect(deployment.status, JSON.stringify(deployment.body)).toBe(201);
    deploymentId = deployment.body.id;
  });

  afterAll(async () => h.close());

  it("API Keyは表示一回、production限定、rate limit付きでRunを作る", async () => {
    const created = await h.request("POST", `/api/v1/deployments/${deploymentId}/api-keys`, { ...owner, body: { name: "CI", rate_limit_per_minute: 1, max_runs_per_day: 2 } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.secret).toMatch(/^as_live_/);
    const listed = await h.request("GET", `/api/v1/deployments/${deploymentId}/api-keys`, owner);
    expect(listed.body[0]).not.toHaveProperty("secret");

    const accepted = await h.app.request(`/triggers/v1/deployments/${deploymentId}/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${created.body.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ input: "API Keyから実行" }),
    });
    expect(accepted.status).toBe(202);
    const first = await accepted.json() as { run_id: string };
    expect(await h.admin.runs.findUnique({ where: { id: first.run_id } })).toMatchObject({ deployment_id: deploymentId, status: "queued" });

    const limited = await h.app.request(`/triggers/v1/deployments/${deploymentId}/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${created.body.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ input: "二重実行" }),
    });
    expect(limited.status).toBe(429);
  });

  it("Webhook署名を検証し、delivery IDの再送は同じRunを返す", async () => {
    const created = await h.request("POST", `/api/v1/deployments/${deploymentId}/webhooks`, { ...owner, body: { name: "Provider", rate_limit_per_minute: 10, max_runs_per_day: 20 } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.signing_secret).toMatch(/^whsec_/);
    const raw = JSON.stringify({ input: "署名Webhookから実行" });
    const signature = `sha256=${createHmac("sha256", created.body.signing_secret).update(raw).digest("hex")}`;
    const invoke = () => h.app.request(created.body.path, { method: "POST", headers: { "content-type": "application/json", "x-agent-studio-signature": signature, "x-agent-studio-delivery": "delivery-1" }, body: raw });
    const first = await invoke();
    expect(first.status).toBe(202);
    const firstBody = await first.json() as { run_id: string; duplicate: boolean };
    expect(firstBody.duplicate).toBe(false);
    const replay = await invoke();
    const replayBody = await replay.json() as { run_id: string; duplicate: boolean };
    expect(replay.status).toBe(202);
    expect(replayBody).toEqual({ run_id: firstBody.run_id, duplicate: true });
  });
});
