import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CompiledFunctionTool } from "../domain/manifest-compiler.js";
import { AuditExporter } from "../worker/audit-export.js";
import { StudioFunctionExecutor } from "../worker/studio-functions.js";
import { createHarness, type Harness } from "./harness.js";

/** 外部に送信しない function tool の実行（テスト用） */
class StubExecutor extends StudioFunctionExecutor {
  readonly calls: { tool: string; args: Record<string, unknown> }[] = [];
  override async execute(_org: string, tool: CompiledFunctionTool, args: Record<string, unknown>): Promise<string> {
    this.calls.push({ tool: tool.name, args });
    return "sent";
  }
}

const identity = (account: string, role: string) => ({ method: "POST", url: `dev://${account}/${role}`, headers: {}, body: "" });

describe("実行の流れ（擬似 OpenAI）", () => {
  let h: Harness;
  let org: { id: string };
  const stub = { executor: null as StubExecutor | null };
  let owner: { email: string; org: string };
  let operator: { email: string; org: string };

  beforeAll(async () => {
    h = createHarness();
    const ownerEmail = `owner-${h.suffix}@example.com`;
    const operatorEmail = `operator-${h.suffix}@example.com`;
    org = await h.createOrg("flow", [
      { email: ownerEmail, role: "owner", approver: true },
      { email: operatorEmail, role: "operator" },
    ]);
    owner = { email: ownerEmail, org: org.id };
    operator = { email: operatorEmail, org: org.id };
    stub.executor = new StubExecutor(h.deps.db, h.deps.secrets);
    h.startWorker(stub.executor);
  });
  afterAll(async () => h.close());

  async function createAgentAndDeploy(manifest: string, profileId: string) {
    const agent = await h.request("POST", "/api/v1/agents", { ...owner, body: { manifest } });
    expect(agent.status, JSON.stringify(agent.body)).toBe(201);
    const published = await h.request("POST", `/api/v1/agents/${agent.body.id}/versions/1/publish`, owner);
    expect(published.status).toBe(200);
    const dep = await h.request("POST", "/api/v1/deployments", {
      ...owner,
      body: { agent_version_id: published.body.id, runtime_profile_id: profileId, stage: "production" },
    });
    return dep;
  }

  const runStatus = (id: string) => h.request("GET", `/api/v1/runs/${id}`, owner).then((r) => r.body);

  it("OpenAI の環境で実行が完了する", async () => {
    const profile = await h.request("POST", "/api/v1/environments", {
      ...owner,
      body: { type: "openai_hosted", key: "openai", name: "OpenAI", template: "general-python", network: { mode: "disabled" } },
    });
    expect(profile.status).toBe(201);
    const dep = await createAgentAndDeploy("agent:\n  key: hello\n  name: こんにちは\ninstructions: 挨拶する\n", profile.body.id);
    expect(dep.status).toBe(201);

    const run = await h.request("POST", "/api/v1/runs", { ...operator, body: { deployment_id: dep.body.id, input: "こんにちは" } });
    expect(run.status).toBe(201);
    const done = await h.waitFor(() => runStatus(run.body.id), (r) => r.status === "completed" || r.status === "failed");
    expect(done.status).toBe("completed");
    expect(done.output).toContain("こんにちは");
    expect(done.usage.input_tokens).toBeGreaterThan(0);
  });

  it("成果物は完了前に S3 に保存され、期限付き URL で取得できる", async () => {
    const deps = await h.request("GET", "/api/v1/deployments", owner);
    const hello = deps.body.find((d: { agent: { key: string } }) => d.agent.key === "hello");
    const run = await h.request("POST", "/api/v1/runs", { ...operator, body: { deployment_id: hello.id, input: "集計して [[artifact:report.csv]]" } });
    const done = await h.waitFor(() => runStatus(run.body.id), (r) => r.status === "completed" || r.status === "failed");
    expect(done.status).toBe("completed");
    const artifacts = await h.request("GET", `/api/v1/runs/${run.body.id}/artifacts`, owner);
    expect(artifacts.body).toEqual([{ path: "report.csv", size_bytes: expect.any(Number), download_url: expect.stringContaining(`orgs/${org.id}/runs/${run.body.id}/report.csv`) }]);
  });

  it("viewer は実行できない（operator 以上）", async () => {
    const viewerEmail = `viewer-${h.suffix}@example.com`;
    await h.request("POST", "/api/v1/members", { ...owner, body: { email: viewerEmail, role: "viewer" } });
    const deps = await h.request("GET", "/api/v1/deployments", owner);
    const res = await h.request("POST", "/api/v1/runs", {
      email: viewerEmail,
      org: org.id,
      body: { deployment_id: deps.body[0].id, input: "x" },
    });
    expect(res.status).toBe(403);
  });

  it("Agent Studio のツールは承認後にだけ実行される", async () => {
    const connection = await h.request("POST", "/api/v1/tools", {
      ...owner,
      body: {
        name: "notify_team",
        display_name: "チームへの通知",
        spec: {
          execution_location: "studio_function",
          description: "チームに通知する",
          risk: "external_send",
          input_schema: { type: "object", properties: { message: { type: "string" } } },
          studio_function: { handler: "http_webhook", url: "https://hooks.example.com/notify" },
        },
      },
    });
    expect(connection.status).toBe(201);
    const profile = await h.request("GET", "/api/v1/environments", owner);
    const dep = await createAgentAndDeploy(
      "agent:\n  key: notifier\n  name: 通知\ninstructions: 通知する\ntools: [notify_team]\npolicies:\n  - type: approval\n    tool: notify_team\n",
      profile.body.find((p: { key: string }) => p.key === "openai").id,
    );
    expect(dep.status).toBe(201);

    const run = await h.request("POST", "/api/v1/runs", {
      ...operator,
      body: { deployment_id: dep.body.id, input: '通知して [[call:notify_team {"message":"在庫が少ない"}]]' },
    });
    await h.waitFor(() => runStatus(run.body.id), (r) => r.status === "waiting_approval");
    expect(stub.executor!.calls).toHaveLength(0);

    const approvals = await h.request("GET", "/api/v1/approvals?status=pending", owner);
    const approval = approvals.body.find((a: { run_id: string }) => a.run_id === run.body.id);
    expect(approval.tool).toBe("notify_team");

    // operator は承認者ではない
    const denied = await h.request("POST", `/api/v1/approvals/${approval.id}/decision`, { ...operator, body: { decision: "approve" } });
    expect(denied.status).toBe(403);

    const ok = await h.request("POST", `/api/v1/approvals/${approval.id}/decision`, { ...owner, body: { decision: "approve" } });
    expect(ok.body.status).toBe("approved");

    const done = await h.waitFor(() => runStatus(run.body.id), (r) => r.status === "completed" || r.status === "failed");
    expect(done.status).toBe("completed");
    expect(done.output).toContain("sent");
    expect(stub.executor!.calls).toEqual([{ tool: "notify_team", args: { message: "在庫が少ない" } }]);
  });

  describe("企業の Runtime（self_hosted）", () => {
    const account = String(Math.floor(1e11 + Math.random() * 8e11));
    const role = "as-flow-prod-runtime";
    let runtimeId: string;
    let access: string;
    let profileId: string;

    it("登録: トークンと AWS の身元の両方が一致した場合だけ登録できる", async () => {
      const rt = await h.request("POST", "/api/v1/runtimes", {
        ...owner,
        body: { name: "flow", stage: "production", provisioning_type: "studio_managed", aws_account_id: account, aws_region: "ap-northeast-1", expected_role_name: role },
      });
      expect(rt.status).toBe(201);
      runtimeId = rt.body.id;
      const token = (await h.request("POST", `/api/v1/runtimes/${runtimeId}/bootstrap-tokens`, owner)).body.token;

      const before = await h.request("POST", "/runtime/v1/token", { body: { identity: identity(account, role) } });
      expect(before.body.error.code).toBe("runtime_not_registered");

      const wrongAccount = await h.request("POST", "/runtime/v1/register", {
        body: { bootstrap_token: token, identity: identity("999999999999", role), controller_version: "test" },
      });
      expect(wrongAccount.status).toBe(403);

      const ok = await h.request("POST", "/runtime/v1/register", {
        body: { bootstrap_token: token, identity: identity(account, role), controller_version: "test" },
      });
      expect(ok.status).toBe(200);
      expect(ok.body.runtime_id).toBe(runtimeId);
      access = ok.body.access_token;

      const reuse = await h.request("POST", "/runtime/v1/register", {
        body: { bootstrap_token: token, identity: identity(account, role), controller_version: "test" },
      });
      expect(reuse.status).toBe(403);

      const hb = await h.request("POST", "/runtime/v1/heartbeat", {
        token: access,
        body: {
          controller_version: "test",
          gateway_url: "http://gateway.flow.internal:8080/mcp",
          active_sessions: [],
          tools: [
            { name: "get_product", description: "取得", input_schema: { type: "object" }, risk: "read", reads_untrusted_content: false },
            { name: "update_price", description: "価格変更", input_schema: { type: "object" }, risk: "financial", reads_untrusted_content: false },
          ],
        },
      });
      expect(hb.status).toBe(200);
      const profile = await h.request("POST", "/api/v1/environments", {
        ...owner,
        body: { type: "self_hosted", key: "flow-prod", name: "Flow の AWS", runtime_id: runtimeId },
      });
      profileId = profile.body.id;
    });

    it("Runtime にないツールを使う Agent はデプロイできない", async () => {
      for (const name of ["get_product", "update_price", "delete_product"]) {
        await h.request("POST", "/api/v1/tools", {
          ...owner,
          body: {
            name,
            display_name: name,
            spec: { execution_location: "runtime_mcp", description: name, risk: name === "get_product" ? "read" : "financial", input_schema: { type: "object" } },
          },
        });
      }
      const dep = await createAgentAndDeploy("agent:\n  key: bad\n  name: bad\ninstructions: x\ntools: [delete_product]\n", profileId);
      expect(dep.status).toBe(412);
      expect(dep.body.error.message).toContain("delete_product");
    });

    it("価格変更: Runtime のジョブ → 承認待ち → 承認 → 完了、承認は1回しか使えない", async () => {
      const dep = await createAgentAndDeploy(
        'agent:\n  key: pricing\n  name: 価格変更\ninstructions: 価格を変える\ntools: [get_product, update_price]\npolicies:\n  - type: approval\n    tool: update_price\n    when: { field: price_change, op: ">", value: 500, abs: true }\n',
        profileId,
      );
      expect(dep.status, JSON.stringify(dep.body)).toBe(201);
      const run = await h.request("POST", "/api/v1/runs", { ...operator, body: { deployment_id: dep.body.id, input: "P-001 を600円下げて" } });

      // Runtime がジョブを受け取る
      const job = await h.waitFor(
        () => h.request("GET", "/runtime/v1/jobs/next?wait=1", { token: access }),
        (r) => r.body?.job?.type === "start_session",
      );
      const session = job.body.job.session;
      expect(session.allowed_tools).toEqual(["get_product", "update_price"]);
      expect(session.policies.some((p: { type: string }) => p.type === "approval")).toBe(true);
      expect(session.token_hash).toMatch(/^[0-9a-f]{64}$/);

      const grants = await h.request("GET", "/runtime/v1/sessions/active", { token: access });
      expect(grants.body.sessions.map((s: { session_id: string }) => s.session_id)).toContain(session.session_id);

      // Tool Gateway が承認を依頼する（Worker が接続する前に依頼しておき、ターン終了時に承認待ちになることを確かめる）
      const argsHash = "a".repeat(64);
      const created = await h.request("POST", "/runtime/v1/approvals", {
        token: access,
        body: { session_id: session.session_id, tool: "update_price", args_hash: argsHash, args_preview: '{"price_change":-600}', reason: "承認が必要", timeout_minutes: 60 },
      });
      expect(created.body.status).toBe("pending");
      const again = await h.request("POST", "/runtime/v1/approvals", {
        token: access,
        body: { session_id: session.session_id, tool: "update_price", args_hash: argsHash, args_preview: "x", reason: "x", timeout_minutes: 60 },
      });
      expect(again.body.approval_id).toBe(created.body.approval_id);

      await h.request("POST", `/runtime/v1/jobs/${job.body.job.job_id}/result`, { token: access, body: { status: "succeeded" } });
      await h.request("POST", `/runtime/v1/sessions/${session.session_id}/events`, { token: access, body: { type: "worker_running" } });

      await h.waitFor(() => runStatus(run.body.id), (r) => r.status === "waiting_approval");
      const notYet = await h.request("POST", `/runtime/v1/approvals/${created.body.approval_id}/consume`, { token: access });
      expect(notYet.body.status).toBe("pending");

      await h.request("POST", `/api/v1/approvals/${created.body.approval_id}/decision`, { ...owner, body: { decision: "approve" } });

      const consumed = await h.request("POST", `/runtime/v1/approvals/${created.body.approval_id}/consume`, { token: access });
      expect(consumed.body.status).toBe("consumed");
      const reuse = await h.request("POST", `/runtime/v1/approvals/${created.body.approval_id}/consume`, { token: access });
      expect(reuse.body.status).toBe("consumed");
      const reuseRow = await h.admin.approvals.findUniqueOrThrow({ where: { id: created.body.approval_id } });
      expect(reuseRow.consumed_at).not.toBeNull();

      const done = await h.waitFor(() => runStatus(run.body.id), (r) => r.status === "completed" || r.status === "failed");
      expect(done.status).toBe("completed");
      // 承認の結果がエージェントへの入力として送られている
      const inputs = await h.admin.run_inputs.findMany({ where: { run_id: run.body.id }, orderBy: { created_at: "asc" } });
      expect(inputs.map((i) => i.kind)).toEqual(["initial", "approval"]);
      expect(inputs.every((i) => i.status === "sent")).toBe(true);

      // 終了後: セッションが後片付けされ、Worker の停止が依頼される
      const stop = await h.waitFor(
        () => h.admin.runtime_jobs.findFirst({ where: { session_id: session.session_id, type: "stop_session" } }),
        (j) => j !== null,
      );
      expect(stop!.status).toBe("pending");
      const grantsAfter = await h.request("GET", "/runtime/v1/sessions/active", { token: access });
      expect(grantsAfter.body.sessions.map((s: { session_id: string }) => s.session_id)).not.toContain(session.session_id);
    });

    it("無効にした Runtime はトークンを使えない", async () => {
      const revoked = await h.request("POST", `/api/v1/runtimes/${runtimeId}/revoke`, owner);
      expect(revoked.body.status).toBe("revoked");
      const hb = await h.request("GET", "/runtime/v1/jobs/next?wait=0", { token: access });
      expect(hb.status).toBe(403);
      const token = await h.request("POST", "/runtime/v1/token", { body: { identity: identity(account, role) } });
      expect(token.body.error.code).toBe("runtime_revoked");
    });
  });

  it("監査ログを1時間ごとに S3 へ書き出す（AUD-03）", async () => {
    // 今の時間帯が「書き出し済みの時間帯」になるよう、2時間後の時刻で実行する
    await new AuditExporter(h.deps).tick(new Date(Date.now() + 2 * 3600_000));
    const exported = [...h.objects.objects.entries()].filter(([k]) => k.startsWith("test-audit/audit-logs/"));
    expect(exported.length).toBeGreaterThan(0);
    const lines = exported.flatMap(([, v]) => v.toString("utf8").split("\n").filter(Boolean)).map((l) => JSON.parse(l));
    expect(lines.some((l) => l.organization_id === org.id && l.action === "run.create")).toBe(true);
  });

  it("監査ログに主要な操作が残る", async () => {
    const logs = await h.request("GET", "/api/v1/audit-logs?limit=200", owner);
    const actions = new Set(logs.body.map((l: { action: string }) => l.action));
    for (const a of ["agent.create", "deployment.create", "run.create", "approval.approved", "runtime.register", "runtime.revoke"]) {
      expect(actions, a).toContain(a);
    }
  });
});
