import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CompiledFunctionTool } from "../domain/manifest-compiler.js";
import { StudioFunctionExecutor } from "../worker/studio-functions.js";
import { createHarness, type Harness } from "./harness.js";

class AsyncPostExecutor extends StudioFunctionExecutor {
  readonly calls: string[] = [];

  override async execute(_organizationId: string, tool: CompiledFunctionTool): Promise<string> {
    this.calls.push(tool.name);
    if (tool.name === "publish_post") return JSON.stringify({ job_id: "factoring-post-1", status: "pending" });
    if (tool.name === "get_job") return JSON.stringify({ id: "factoring-post-1", status: "succeeded" });
    return "{}";
  }
}

describe("Workflow v2", () => {
  let h: Harness;
  let org: { id: string };
  const owner = "workflow-v2-owner@example.com";
  const builder = "workflow-v2-builder@example.com";
  const approver = "workflow-v2-approver@example.com";
  let executor: AsyncPostExecutor;

  beforeAll(async () => {
    h = createHarness();
    org = await h.createOrg("workflow-v2", [
      { email: owner, role: "owner", approver: true },
      { email: builder, role: "builder" },
      { email: approver, role: "operator", approver: true },
    ]);
    executor = new AsyncPostExecutor(h.deps.db, h.deps.secrets);
    h.startWorker(executor);
  });
  afterAll(async () => h.close());

  it("条件分岐、永続Wait、承認、Transformを再開可能に実行する", async () => {
    const created = await h.request("POST", "/api/v1/workflows", {
      email: builder,
      org: org.id,
      body: {
        key: `factoring-v2-${h.suffix}`,
        name: "ファクタリング決定フロー",
        definition: {
          version: 2,
          start: "under-limit",
          steps: [
            { type: "condition", key: "under-limit", name: "100万円未満", condition: { source: "input", path: "requested_amount", operator: "lt", value: 1_000_000 }, if_true: "settle", if_false: "hold" },
            { type: "wait", key: "settle", name: "外部処理の完了待ち", seconds: 0, next: "final-approval" },
            { type: "approval", key: "final-approval", name: "最終承認", message: "候補を確認してください: {{input}}", next: "approved", on_denied: "hold" },
            { type: "transform", key: "approved", name: "可を出力", output_template: '{"decision":"可"}' },
            { type: "transform", key: "hold", name: "保留を出力", output_template: '{"decision":"保留"}' },
          ],
        },
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const started = await h.request("POST", `/api/v1/workflows/${created.body.id}/runs`, {
      email: builder,
      org: org.id,
      body: { input: JSON.stringify({ requested_amount: 800000 }) },
    });
    expect(started.status).toBe(201);
    const waiting = await h.waitFor(
      () => h.request("GET", `/api/v1/workflow-runs/${started.body.id}`, { email: builder, org: org.id }),
      (response) => response.body.status === "waiting_approval",
    );
    expect(waiting.body.steps.find((step: { key: string }) => step.key === "settle")).toMatchObject({ status: "completed", output: '{"waited_seconds":0}' });

    const approvals = await h.request("GET", "/api/v1/approvals?status=pending", { email: approver, org: org.id });
    const approval = approvals.body.find((candidate: { tool: string }) => candidate.tool === "workflow_approval");
    expect(approval).toBeTruthy();
    const decided = await h.request("POST", `/api/v1/approvals/${approval.id}/decision`, { email: approver, org: org.id, body: { decision: "approve", comment: "確認済み" } });
    expect(decided.status).toBe(200);

    const completed = await h.waitFor(
      () => h.request("GET", `/api/v1/workflow-runs/${started.body.id}`, { email: builder, org: org.id }),
      (response) => response.body.status === "completed",
    );
    expect(completed.body.steps.find((step: { key: string }) => step.key === "approved")).toMatchObject({ status: "completed", output: '{"decision":"可"}' });
    expect(completed.body.steps.find((step: { key: string }) => step.key === "hold").status).toBe("skipped");
  });

  it("条件がfalseなら承認へ進まず保留分岐を決定的に選ぶ", async () => {
    const [workflow] = (await h.request("GET", "/api/v1/workflows", { email: builder, org: org.id })).body;
    const started = await h.request("POST", `/api/v1/workflows/${workflow.id}/runs`, {
      email: builder,
      org: org.id,
      body: { input: JSON.stringify({ requested_amount: 1_500_000 }) },
    });
    const completed = await h.waitFor(
      () => h.request("GET", `/api/v1/workflow-runs/${started.body.id}`, { email: builder, org: org.id }),
      (response) => response.body.status === "completed",
    );
    expect(completed.body.steps.find((step: { key: string }) => step.key === "hold")).toMatchObject({ status: "completed", output: '{"decision":"保留"}' });
    expect(completed.body.steps.find((step: { key: string }) => step.key === "final-approval").status).toBe("skipped");
  });

  it("外部投稿は承認後に1回だけ実行し、provider Job成功までWorkflowを完了しない", async () => {
    const connector = await h.request("POST", "/api/v1/connectors", {
      email: builder,
      org: org.id,
      body: {
        key: `workflow-social-${h.suffix}`,
        name: "Workflow Social",
        description: "非同期投稿",
        adapter: "http_openapi",
        base_url: "https://social.example.test",
        auth_type: "none",
        operations: [
          {
            name: "publish_post",
            display_name: "公開投稿",
            description: "審査結果を公開する",
            method: "POST",
            path: "/posts",
            risk: "external_send",
            idempotency_key_field: "logical_post_id",
            input_schema: { type: "object", properties: { account_id: { type: "string" }, text: { type: "string" }, logical_post_id: { type: "string" } }, required: ["account_id", "text", "logical_post_id"], additionalProperties: false },
          },
          {
            name: "get_job",
            display_name: "投稿結果を確認",
            description: "投稿Jobを確認する",
            method: "GET",
            path: "/jobs/{id}",
            risk: "read",
            input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
          },
        ],
      },
    });
    expect(connector.status, JSON.stringify(connector.body)).toBe(201);

    const environment = await h.request("POST", "/api/v1/environments", {
      email: owner,
      org: org.id,
      body: { type: "openai_hosted", key: `workflow-openai-${h.suffix}`, name: "Workflow OpenAI", template: "general-python", network: { mode: "disabled" } },
    });
    const agent = await h.request("POST", "/api/v1/agents", {
      email: builder,
      org: org.id,
      body: { manifest: `agent:\n  key: workflow-publisher-${h.suffix}\n  name: Workflow Publisher\ninstructions: 審査結果を投稿する\ntools: [publish_post, get_job]\n` },
    });
    const published = await h.request("POST", `/api/v1/agents/${agent.body.id}/versions/1/publish`, { email: builder, org: org.id });
    const deployment = await h.request("POST", "/api/v1/deployments", {
      email: builder,
      org: org.id,
      body: { agent_version_id: published.body.id, runtime_profile_id: environment.body.id, stage: "staging" },
    });
    expect(deployment.status, JSON.stringify(deployment.body)).toBe(201);

    const workflow = await h.request("POST", "/api/v1/workflows", {
      email: builder,
      org: org.id,
      body: {
        key: `workflow-async-post-${h.suffix}`,
        name: "非同期投稿Workflow",
        definition: {
          version: 2,
          start: "publish",
          steps: [{
            type: "tool",
            key: "publish",
            name: "匿名審査結果を投稿",
            deployment_id: deployment.body.id,
            tool_name: "publish_post",
            arguments_template: '{"account_id":"x-test","text":"審査結果: 可, 理由: TEST_OK","logical_post_id":{{workflow_run_id}}}',
          }],
        },
      },
    });
    expect(workflow.status, JSON.stringify(workflow.body)).toBe(201);
    const started = await h.request("POST", `/api/v1/workflows/${workflow.body.id}/runs`, {
      email: approver,
      org: org.id,
      body: { input: "{}" },
    });
    expect(started.status).toBe(201);

    const pendingApprovals = await h.waitFor(
      () => h.request("GET", "/api/v1/approvals?status=pending", { email: approver, org: org.id }),
      (response) => response.body.some((candidate: { tool: string }) => candidate.tool === "publish_post"),
      45_000,
    );
    expect(executor.calls.filter((name) => name === "publish_post")).toHaveLength(0);
    const approval = pendingApprovals.body.find((candidate: { tool: string }) => candidate.tool === "publish_post");
    expect(approval).toBeTruthy();
    await h.request("POST", `/api/v1/approvals/${approval.id}/decision`, {
      email: approver,
      org: org.id,
      body: { decision: "approve", comment: "匿名化済み" },
    });

    const waiting = await h.waitFor(
      () => h.request("GET", `/api/v1/workflow-runs/${started.body.id}`, { email: builder, org: org.id }),
      (response) => response.body.status === "waiting_external",
      45_000,
    );
    expect(waiting.body.steps[0]).toMatchObject({ status: "running", output: expect.stringContaining("factoring-post-1") });
    expect(executor.calls.filter((name) => name === "publish_post")).toHaveLength(1);

    const completed = await h.waitFor(
      () => h.request("GET", `/api/v1/workflow-runs/${started.body.id}`, { email: builder, org: org.id }),
      (response) => response.body.status === "completed",
      30_000,
    );
    expect(completed.body.steps[0].status).toBe("completed");
    expect(executor.calls.filter((name) => name === "publish_post")).toHaveLength(1);
    expect(executor.calls.filter((name) => name === "get_job")).toHaveLength(1);
  });
});
