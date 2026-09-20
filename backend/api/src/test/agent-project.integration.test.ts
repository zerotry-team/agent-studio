import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

const browserOperations = [
  {
    name: "browser_navigate",
    display_name: "Webページを開く",
    description: "指定した公開URLをBrowserで開く",
    risk: "read",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
  },
  {
    name: "browser_snapshot",
    display_name: "ページ内容を読み取る",
    description: "公開ページの表示内容を取得する",
    risk: "read",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const socialOperations = [
  ["list_accounts", "アカウントを確認", "GET", "/v1/accounts", "read"],
  ["list_posts", "過去投稿を取得", "GET", "/v1/posts", "read"],
  ["get_post", "投稿詳細を取得", "GET", "/v1/posts/{id}", "read"],
  ["publish_post", "SNSへ公開投稿", "POST", "/v1/posts", "external_send"],
  ["get_job", "投稿結果を確認", "GET", "/v1/jobs/{id}", "read"],
].map(([name, display_name, method, path, risk]) => ({
  name,
  display_name,
  description: display_name,
  method,
  path,
  risk,
  input_schema: { type: "object", properties: {}, additionalProperties: true },
}));

describe("Agent Project / Preview / Promote", () => {
  let h: Harness;
  let owner: { email: string; org: string };
  let projectId: string;
  let socialConnectorId: string;
  let previewConnectionId: string;
  let productionConnectionId: string;
  let firstProductionId: string;
  let firstBuildId: string;

  beforeAll(async () => {
    h = createHarness();
    // この結合テストは接続・設定値・Buildを検証する。キーワード推測の生成器には依存しない。
    h.deps.generator.generate = async () => ({
      key: "social-post-agent", name: "SNS投稿Agent", description: "SNS投稿の分析と公開",
      instructions: "ベンチマークと過去投稿を分析し、投稿案を作成してください。",
      variables: [
        { name: "BENCHMARK_URL", label: "調査先", description: "調査するURL", example: null, required: true },
        { name: "ACCOUNT_ID", label: "アカウント", description: "投稿するアカウント", example: null, required: true },
        { name: "BRAND_TONE", label: "文体", description: "投稿の文体", example: null, required: true },
      ],
      requirements: [
        { description: "Webを調査", kind: "tool", candidate_tools: ["browser_navigate", "browser_snapshot"], confidence: 1, reason: "Browser", uses_variables: ["BENCHMARK_URL"] },
        { description: "投稿を分析して公開", kind: "tool", candidate_tools: socialOperations.map((operation) => operation.name!), confidence: 1, reason: "Social Router", uses_variables: ["ACCOUNT_ID", "BRAND_TONE"] },
      ],
      conditional_approvals: [],
    });
    const email = `project-owner-${h.suffix}@example.com`;
    const org = await h.createOrg("project", [{ email, role: "owner", approver: true }]);
    owner = { email, org: org.id };

    const runtime = await h.admin.runtimes.create({
      data: {
        organization_id: org.id,
        name: "Browser Runtime",
        stage: "production",
        provisioning_type: "studio_managed",
        aws_account_id: `${Date.now()}`.slice(-12).padStart(12, "7"),
        aws_region: "ap-northeast-1",
        expected_role_name: `project-${h.suffix}`,
        status: "active",
        gateway_url: "http://gateway.test/mcp",
        tool_catalog: browserOperations.map((operation) => ({ ...operation, reads_untrusted_content: true })),
      },
    });
    await h.admin.runtime_profiles.create({
      data: { organization_id: org.id, key: "browser-runtime", name: "Browser Runtime", type: "self_hosted", runtime_id: runtime.id },
    });

    const browser = await h.request("POST", "/api/v1/connectors", {
      ...owner,
      body: { key: "browser", name: "Browser", description: "公開ページの調査", adapter: "runtime", auth_type: "none", operations: browserOperations },
    });
    expect(browser.status, JSON.stringify(browser.body)).toBe(201);

    const social = await h.request("POST", "/api/v1/connectors", {
      ...owner,
      body: {
        key: "social-router",
        name: "Social Router",
        description: "SNS投稿の分析と公開",
        adapter: "http_openapi",
        base_url: "https://social.example.com",
        auth_type: "static_bearer",
        operations: socialOperations,
      },
    });
    expect(social.status, JSON.stringify(social.body)).toBe(201);
    socialConnectorId = social.body.id;
    expect(social.body.tools).toHaveLength(5);

    for (const [name, secret] of [["Preview", "preview-secret-value"], ["Production", "production-secret-value"]] as const) {
      const connection = await h.request("POST", "/api/v1/connections", {
        ...owner,
        body: { name, connector_id: socialConnectorId, scope: "studio", header_name: "Authorization" },
      });
      expect(connection.status).toBe(201);
      const saved = await h.request("PUT", `/api/v1/connections/${connection.body.id}/secret`, { ...owner, body: { value: secret } });
      expect(saved.status).toBe(204);
      if (name === "Preview") previewConnectionId = connection.body.id;
      else productionConnectionId = connection.body.id;
    }
  });

  afterAll(async () => h.close());

  it("Browser Agentは接続範囲を決めるまでPreviewを作らない", async () => {
    const originalGenerate = h.deps.generator.generate;
    h.deps.generator.generate = async () => ({
      key: "browser-report-agent",
      name: "競合料金比較レポート",
      description: "公開料金ページを比較する",
      instructions: "公開されている料金ページを確認し、比較してください。",
      variables: [],
      requirements: [
        {
          description: "公開料金ページを確認する",
          kind: "tool",
          candidate_tools: ["browser_navigate", "browser_snapshot"],
          confidence: 1,
          reason: "Browser",
          uses_variables: [],
        },
      ],
      conditional_approvals: [],
    });
    try {
      const created = await h.request("POST", "/api/v1/agent-projects", {
        ...owner,
        body: { description: "競合の公開料金ページを比較してレポートにする" },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.agent.capability_resolution.ready).toBe(true);
      expect(created.body.auto_preview_created).toBe(false);
      expect(created.body.builds).toHaveLength(0);
      expect(created.body.deployments).toHaveLength(0);

      const blocked = await h.request("POST", `/api/v1/agents/${created.body.agent.id}/preview`, owner);
      expect(blocked.status).toBe(412);
      expect(blocked.body.error.message).toContain("ブラウザで接続できる範囲");

      const configured = await h.request("PUT", `/api/v1/agents/${created.body.agent.id}/browser-access`, {
        ...owner,
        body: { access: "restricted", allowed_domains: ["example.com"] },
      });
      expect(configured.status).toBe(200);
      const preview = await h.request("POST", `/api/v1/agents/${created.body.agent.id}/preview`, owner);
      expect(preview.status, JSON.stringify(preview.body)).toBe(201);
    } finally {
      h.deps.generator.generate = originalGenerate;
    }
  });

  it("不足ConnectionとVariablesだけを設定し、Preview Buildを作る", async () => {
    const created = await h.request("POST", "/api/v1/agent-projects", {
      ...owner,
      body: { description: "ベンチマーク投稿と自社の過去投稿を分析し、投稿案を作成してSocial Router経由でSNSへ投稿する。" },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    projectId = created.body.agent.id;
    const tools = created.body.agent.versions[0].manifest.tools;
    expect(tools).toEqual(expect.arrayContaining(["browser_navigate", "browser_snapshot", "list_accounts", "list_posts", "get_post", "publish_post", "get_job"]));
    expect(tools).not.toEqual(expect.arrayContaining(["get_product", "update_price"]));
    expect(created.body.agent.capability_resolution.ready).toBe(false);

    for (const [stage, connection_id] of [["staging", previewConnectionId], ["production", productionConnectionId]] as const) {
      const linked = await h.request("PUT", `/api/v1/agents/${projectId}/connections`, {
        ...owner,
        body: { stage, connector_id: socialConnectorId, connection_id, allowed_capabilities: socialOperations.map((operation) => operation.name) },
      });
      expect(linked.status, JSON.stringify(linked.body)).toBe(200);
      const variables = await h.request("PUT", `/api/v1/agents/${projectId}/environment`, {
        ...owner,
        body: { stage, variables: { BENCHMARK_URL: "https://example.com", ACCOUNT_ID: "account-test", BRAND_TONE: "簡潔で誠実" } },
      });
      expect(variables.status).toBe(200);
    }

    const browserAccess = await h.request("PUT", `/api/v1/agents/${projectId}/browser-access`, {
      ...owner,
      body: { access: "restricted", allowed_domains: ["example.com"] },
    });
    expect(browserAccess.status).toBe(200);
    const createdPreview = await h.request("POST", `/api/v1/agents/${projectId}/preview`, owner);
    expect(createdPreview.status, JSON.stringify(createdPreview.body)).toBe(201);

    const project = await h.request("GET", `/api/v1/agents/${projectId}/project`, owner);
    expect(project.body.agent.capability_resolution.ready).toBe(true);
    const preview = project.body.deployments.find((deployment: { stage: string; status: string }) => deployment.stage === "staging" && deployment.status === "active");
    expect(preview?.build_id).toBeTruthy();
    firstBuildId = preview.build_id;
    expect(project.body.preview_api_url).toContain(`/agents/${projectId}/invoke?stage=staging`);
    expect(JSON.stringify(project.body)).not.toContain("preview-secret-value");
    expect(JSON.stringify(project.body)).not.toContain("production-secret-value");
    const build = project.body.builds.find((item: { id: string }) => item.id === firstBuildId);
    expect(build.build_log.map((item: { message: string }) => item.message).join(" ")).toContain("能力を固定");
    const stored = await h.admin.agent_builds.findUniqueOrThrow({ where: { id: firstBuildId } });
    expect(JSON.stringify(stored.compiled_config)).not.toContain("secret-value");
  });

  it("Previewと同じBuildをProductionへPromoteし、過去BuildへRollbackする", async () => {
    const project = await h.request("GET", `/api/v1/agents/${projectId}/project`, owner);
    const preview = project.body.deployments.find((deployment: { stage: string; status: string }) => deployment.stage === "staging" && deployment.status === "active");
    const promoted = await h.request("POST", `/api/v1/deployments/${preview.id}/promote`, owner);
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(201);
    expect(promoted.body.build_id).toBe(firstBuildId);
    firstProductionId = promoted.body.id;

    const secondPreview = await h.request("POST", `/api/v1/agents/${projectId}/preview`, owner);
    expect(secondPreview.status).toBe(201);
    expect(secondPreview.body.build_id).not.toBe(firstBuildId);
    const secondProduction = await h.request("POST", `/api/v1/deployments/${secondPreview.body.id}/promote`, owner);
    expect(secondProduction.status).toBe(201);
    const rolledBack = await h.request("POST", `/api/v1/deployments/${firstProductionId}/rollback`, owner);
    expect(rolledBack.status, JSON.stringify(rolledBack.body)).toBe(201);
    expect(rolledBack.body.build_id).toBe(firstBuildId);
  });

  it("Agent ProjectにScheduleを作成して停止・再開できる", async () => {
    const created = await h.request("POST", `/api/v1/agents/${projectId}/schedules`, {
      ...owner,
      body: {
        name: "平日の投稿案作成",
        stage: "staging",
        input: "ベンチマークを分析して投稿案を作成してください。公開はしないでください。",
        timezone: "Asia/Tokyo",
        local_time: "09:00",
        days_of_week: [1, 2, 3, 4, 5],
        enabled: true,
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.enabled).toBe(true);
    expect(created.body.next_run_at).toBeTruthy();

    const stopped = await h.request("PATCH", `/api/v1/schedules/${created.body.id}`, { ...owner, body: { enabled: false } });
    expect(stopped.status).toBe(200);
    expect(stopped.body.enabled).toBe(false);

    const listed = await h.request("GET", `/api/v1/agents/${projectId}/schedules`, owner);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.body.id, enabled: false })]));
  });

  it("別組織Connectionをアプリと複合外部キーで拒否する", async () => {
    const otherEmail = `other-${h.suffix}@example.com`;
    const other = await h.createOrg("project-other", [{ email: otherEmail, role: "owner" }]);
    const otherConnector = await h.admin.connectors.create({
      data: { organization_id: other.id, key: "social-router", name: "Other", description: "Other", adapter: "http_openapi", auth_type: "static_bearer" },
    });
    const otherConnection = await h.admin.connections.create({
      data: { organization_id: other.id, connector_id: otherConnector.id, name: "Other", scope: "studio", secret_locator: `memory://${randomUUID()}` },
    });
    const response = await h.request("PUT", `/api/v1/agents/${projectId}/connections`, {
      ...owner,
      body: { stage: "staging", connector_id: socialConnectorId, connection_id: otherConnection.id, allowed_capabilities: ["list_posts"] },
    });
    expect(response.status).toBe(400);
    await expect(
      h.admin.agent_connection_links.create({
        data: {
          organization_id: owner.org,
          agent_id: projectId,
          connector_id: socialConnectorId,
          connection_id: otherConnection.id,
          stage: "staging-cross-org",
          allowed_capabilities: ["list_posts"],
        },
      }),
    ).rejects.toThrow();
  });
});
