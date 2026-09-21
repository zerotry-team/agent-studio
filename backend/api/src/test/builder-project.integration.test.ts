import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.js";

const browserOperations = [
  ["browser_navigate", "指定URLを開く", "read", { url: { type: "string" } }],
  ["browser_snapshot", "ページのSnapshotを取得", "read", {}],
  ["browser_screenshot", "ページのScreenshotを取得", "read", {}],
  ["browser_click", "画面要素を選択", "write", { role: { type: "string" }, name: { type: "string" } }],
  ["browser_type", "画面へ入力", "write", { text: { type: "string" } }],
] as const;

describe("Builder Project", () => {
  let h: Harness;
  let org: { id: string };
  const email = "builder-project@example.com";
  const adminEmail = "builder-project-admin@example.com";

  beforeAll(async () => {
    h = createHarness();
    h.deps.mcpDiscovery = vi.fn(async () => [{
      name: "search-docs",
      description: "公開ドキュメントを検索する",
      input_schema: { type: "object" as const, properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
      read_only: true,
      destructive: false,
    }]);
    org = await h.createOrg("builder-project", [{ email, role: "builder" }, { email: adminEmail, role: "admin" }]);
    await h.admin.runtime_profiles.create({ data: { organization_id: org.id, key: "builder-preview", name: "Builder Preview", type: "openai_hosted" } });
    h.startWorker();
  });
  afterAll(async () => h.close());

  it("Agent作成入口で仮AgentとBuilder Jobを同時に作り、同じAgentへ復帰できる", async () => {
    const created = await h.request("POST", "/api/v1/agent-projects", {
      email,
      org: org.id,
      body: {
        description: "請求書を照合し、確認結果を担当者へ説明するAgentをPreviewまで作成してください。",
        target: "preview",
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.agent).toMatchObject({ latest_version: 0, builder_status: "draft" });
    expect(created.body.build_jobs).toHaveLength(1);
    expect(created.body.build_jobs[0]).toMatchObject({
      agent_id: created.body.agent.id,
      status: "draft",
      target: "preview",
    });

    const restored = await h.request("GET", `/api/v1/agents/${created.body.agent.id}/project`, { email, org: org.id });
    expect(restored.status).toBe(200);
    expect(restored.body.agent.id).toBe(created.body.agent.id);
    expect(restored.body.build_jobs[0].agent_id).toBe(created.body.agent.id);

    const materialized = await h.waitFor(
      () => h.request("GET", `/api/v1/agents/${created.body.agent.id}`, { email, org: org.id }),
      (response) => response.body.latest_version === 1,
    );
    expect(materialized.body.key).toBe(created.body.agent.key);

    const otherEmail = `agent-shell-other-${h.suffix}@example.com`;
    const other = await h.createOrg("agent-shell-other", [{ email: otherEmail, role: "owner" }]);
    const hidden = await h.request("GET", `/api/v1/agents/${created.body.agent.id}/project`, { email: otherEmail, org: other.id });
    expect(hidden.status).toBe(404);
  });

  it("依頼を永続化し、WorkerがCapability Planを生成する", async () => {
    const created = await h.request("POST", "/api/v1/builder-projects", {
      email,
      org: org.id,
      body: {
        request: "請求書を確認し、登録済みの情報と照合して結果を担当者へ説明するAgentを作成してください。",
        target: "preview",
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("draft");
    expect(created.body.agent_id).toMatch(/[0-9a-f-]{36}/);

    const completed = await h.waitFor(
      () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email, org: org.id }),
      (response) => ["implementing", "waiting_human_action", "previewing", "completed", "failed"].includes(response.body.status),
    );
    expect(completed.status).toBe(200);
    expect(completed.body.status).not.toBe("failed");
    expect(completed.body.agent_id).toBe(created.body.agent_id);
    expect(completed.body.latest_plan).not.toBeNull();
    expect(completed.body.runs[0].status).toBe("completed");
    expect(completed.body.runs[0].steps.every((step: { status: string }) => step.status === "completed")).toBe(true);
  });

  it("別組織からProjectを参照できない", async () => {
    const otherEmail = `other-${h.suffix}@example.com`;
    const other = await h.createOrg("builder-other", [{ email: otherEmail, role: "owner" }]);
    const list = await h.request("GET", "/api/v1/builder-projects", { email: otherEmail, org: other.id });
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
  });

  it("ログイン必須サイトはBrowser Flowを固定し、Human Loginだけで停止する", async () => {
    const created = await h.request("POST", "/api/v1/builder-projects", {
      email,
      org: org.id,
      body: { request: "反社一覧サイトで法人番号と会社名を照合して結果を説明するAgentを作ってください。", target: "preview" },
    });
    const waiting = await h.waitFor(
      () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email, org: org.id }),
      (response) => response.body.status === "waiting_human_action",
    );
    const question = waiting.body.human_actions.find((action: { resume_condition?: { topic?: string }; status: string }) =>
      action.status === "pending" && action.resume_condition?.topic === "compliance_source");
    const invalid = await h.request("POST", `/api/v1/builder-human-actions/${question.id}/complete`, {
      email,
      org: org.id,
      body: { answers: { source_url: "https://compliance.example.test/search", search_key: "法人番号と会社名", access_method: "password_in_chat" } },
    });
    expect(invalid.status).toBe(400);
    const answered = await h.request("POST", `/api/v1/builder-human-actions/${question.id}/complete`, {
      email,
      org: org.id,
      body: { answers: { source_url: "https://compliance.example.test/search", search_key: "法人番号と会社名", access_method: "human_login" } },
    });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body.status).toBe("waiting_human_action");
    expect(answered.body.change_sets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "browser_flow",
        status: "planned",
        artifacts: expect.arrayContaining([
          expect.objectContaining({ type: "allowed_domain", name: "compliance.example.test" }),
          expect.objectContaining({ type: "browser_mode", name: "authenticated_restricted" }),
        ]),
      }),
    ]));
    const login = answered.body.human_actions.find((action: { type: string; status: string }) => action.type === "human_login" && action.status === "pending");
    expect(login).toMatchObject({ resume_condition: { type: "browser_profile_ready", domain: "compliance.example.test" } });
    const falseCompletion = await h.request("POST", `/api/v1/builder-human-actions/${login.id}/complete`, {
      email,
      org: org.id,
      body: { answers: {} },
    });
    expect(falseCompletion.status).toBe(409);
  });

  it("公開情報の照合はOpenAI標準能力で自動Previewする", async () => {
    const runtimeBuilderEmail = `runtime-builder-${h.suffix}@example.com`;
    const runtimeOrg = await h.createOrg("browser-runtime-setup", [
      { email: runtimeBuilderEmail, role: "builder" },
    ]);
    await h.admin.runtime_profiles.create({ data: { organization_id: runtimeOrg.id, key: "builder-preview", name: "Builder Preview", type: "openai_hosted" } });
    const created = await h.request("POST", "/api/v1/builder-projects", {
      email: runtimeBuilderEmail,
      org: runtimeOrg.id,
      body: { request: "反社一覧サイトで法人番号を照合するAgentを作ってください。", target: "preview" },
    });
    const waiting = await h.waitFor(
      () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email: runtimeBuilderEmail, org: runtimeOrg.id }),
      (response) => response.body.status === "waiting_human_action",
    );
    const question = waiting.body.human_actions.find((action: { resume_condition?: { topic?: string }; status: string }) =>
      action.status === "pending" && action.resume_condition?.topic === "compliance_source");
    const answered = await h.request("POST", `/api/v1/builder-human-actions/${question.id}/complete`, {
      email: runtimeBuilderEmail,
      org: runtimeOrg.id,
      body: { answers: { source_url: "https://compliance.example.test/search", search_key: "法人番号", access_method: "public_web" } },
    });
    expect(answered.status).toBe(200);
    const completed = await h.waitFor(
      () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email: runtimeBuilderEmail, org: runtimeOrg.id }),
      (response) => ["completed", "failed"].includes(response.body.status),
      30_000,
    );
    expect(completed.body.status, JSON.stringify(completed.body)).toBe("completed");
    expect(completed.body.human_actions.some((action: { status: string; resume_condition?: { type?: string } }) =>
      action.status === "pending" && action.resume_condition?.type === "browser_runtime_ready")).toBe(false);
    expect(completed.body.releases[0]).toMatchObject({ status: "preview_succeeded", required_tools: [] });
  });

  it("公開サイトのBrowser Flowを登録済みBrowser ToolとRuntimeへ固定してPreviewを開始する", async () => {
    const browserEmail = `browser-builder-${h.suffix}@example.com`;
    const browserAdminEmail = `browser-admin-${h.suffix}@example.com`;
    const browserOrg = await h.createOrg("builder-browser", [
      { email: browserEmail, role: "builder" },
      { email: browserAdminEmail, role: "admin" },
    ]);
    await h.admin.runtime_profiles.create({ data: { organization_id: browserOrg.id, key: "builder-preview", name: "Builder Preview", type: "openai_hosted" } });
    const browserRuntime = await h.admin.runtimes.create({ data: {
      organization_id: browserOrg.id,
      name: "Builder Browser Runtime",
      stage: "production",
      provisioning_type: "studio_managed",
      aws_account_id: `${Date.now()}`.slice(-12).padStart(12, "8"),
      aws_region: "ap-northeast-1",
      expected_role_name: `builder-browser-${h.suffix}`,
      status: "active",
      gateway_url: "http://browser-gateway.test/mcp",
      tool_catalog: browserOperations.map(([name, display_name, risk]) => ({ name, display_name, description: display_name, risk, reads_untrusted_content: true })),
    } });
    await h.admin.runtime_profiles.create({ data: { organization_id: browserOrg.id, key: "builder-browser", name: "Builder Browser", type: "self_hosted", runtime_id: browserRuntime.id } });
    const browser = await h.request("POST", "/api/v1/connectors", {
      email: browserAdminEmail,
      org: browserOrg.id,
      body: {
        key: "builder-browser",
        name: "ブラウザ操作",
        description: "許可された公開サイトをRun専用Browserで操作する",
        adapter: "runtime",
        auth_type: "none",
        operations: browserOperations.map(([name, display_name, risk, properties]) => ({
          name,
          display_name,
          description: display_name,
          risk,
          input_schema: { type: "object", properties, additionalProperties: false },
        })),
      },
    });
    expect(browser.status, JSON.stringify(browser.body)).toBe(201);
    const created = await h.request("POST", "/api/v1/builder-projects", {
      email: browserEmail,
      org: browserOrg.id,
      body: { request: "反社一覧サイトで法人番号と会社名を照合し、一致有無と出典を返すAgentを作ってください。", target: "preview" },
    });
    const waiting = await h.waitFor(
      () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email: browserEmail, org: browserOrg.id }),
      (response) => response.body.status === "waiting_human_action",
    );
    const question = waiting.body.human_actions.find((action: { resume_condition?: { topic?: string }; status: string }) =>
      action.status === "pending" && action.resume_condition?.topic === "compliance_source");
    const generateSpy = vi.spyOn(h.deps.generator, "generate");
    const answered = await h.request("POST", `/api/v1/builder-human-actions/${question.id}/complete`, {
      email: browserEmail,
      org: browserOrg.id,
      body: { answers: { source_url: "https://compliance.example.test/search", search_key: "法人番号と会社名", access_method: "public_web" } },
    });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);

    const previewing = await h.waitFor(
      () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email: browserEmail, org: browserOrg.id }),
      (response) => ["previewing", "failed"].includes(response.body.status),
    );
    expect(generateSpy).not.toHaveBeenCalled();
    generateSpy.mockRestore();
    expect(previewing.body.status, JSON.stringify(previewing.body)).toBe("previewing");
    expect(previewing.body.releases).toHaveLength(1);
    expect(previewing.body.releases[0].required_tools).toEqual(expect.arrayContaining([
      "browser_navigate", "browser_snapshot", "browser_screenshot",
    ]));
    expect(previewing.body.change_sets).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "browser_flow", status: "applied" }),
    ]));
    const agent = await h.admin.agents.findUniqueOrThrow({
      where: { id: previewing.body.releases[0].agent_id },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    });
    expect(agent.browser_access).toBe("restricted");
    expect(agent.browser_allowed_domains).toEqual(["compliance.example.test"]);
    expect(agent.capability_resolution).toMatchObject({ ready: true, selected_tools: expect.arrayContaining(["browser_snapshot"]) });
    expect(agent.versions[0]?.manifest).toMatchObject({ environment: { profile: "builder-browser" } });
  });

  it("不足している業務事実だけを質問し、回答を保存して自動再開する", async () => {
    const created = await h.request("POST", "/api/v1/builder-projects", {
      email,
      org: org.id,
      body: {
        request: "過去の問い合わせ履歴を確認します。口座写画像はファイルサーバーから取得し、反社一覧サイトと自社で審査に落とした人一覧を照合します。100万円以上は冗長のパスへ進め、最後に審査結果をXに投稿するAgentを作ってください。",
        target: "preview",
      },
    });
    const waiting = await h.waitFor(
      () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email, org: org.id }),
      (response) => response.body.status === "waiting_human_action",
    );
    const questions = waiting.body.human_actions.filter((action: { status: string; resume_condition?: { type?: string } }) => action.status === "pending" && action.resume_condition?.type === "builder_answers");
    expect(questions.map((action: { resume_condition: { topic: string } }) => action.resume_condition.topic)).toEqual(expect.arrayContaining([
      "past_inquiry_source", "bank_document_source", "compliance_source", "internal_denied_list", "over_limit_route", "public_x_post",
    ]));
    expect(questions).toHaveLength(6);
    expect(waiting.body.human_actions.filter((action: { status: string }) => action.status === "pending")).toHaveLength(6);

    const sample: Record<string, string> = {
      document_source: "顧客AWS S3のprivate bucketをRuntime IAM Roleで読む",
      source_url: "https://compliance.example.test/search",
      search_key: "法人番号と会社名",
      access_method: "public_web",
      system: "社内API",
      lookup_key: "法人番号と顧客ID",
      match_fields: "法人番号と代表者名",
      route: "保留にして部長承認へ回す",
      account_id: "x-test-account",
      account_purpose: "検証専用の非公開アカウント",
      public_payload: "匿名審査ID、結果、理由コードのみ",
      integration: "Social Router Connector",
    };
    const allPending = waiting.body.human_actions.filter((action: { status: string }) => action.status === "pending");
    for (const action of allPending) {
      const answers = Object.fromEntries(action.fields
        .filter((field: { name: string; required?: boolean }) => field.required !== false || sample[field.name] !== undefined)
        .map((field: { name: string }) => [field.name, sample[field.name] ?? "確認済み"]));
      const completed = await h.request("POST", `/api/v1/builder-human-actions/${action.id}/complete`, { email, org: org.id, body: { answers } });
      expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    }
    const repositorySetup = await h.waitFor(
      () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email, org: org.id }),
      (response) => response.body.runs.length >= 2
        && response.body.status === "waiting_human_action"
        && response.body.human_actions.some((action: { resume_condition?: { type?: string }; status: string }) =>
          action.status === "pending" && action.resume_condition?.type === "github_repository_connected"),
      30_000,
    );
    const repositoryAction = repositorySetup.body.human_actions.find((action: { resume_condition?: { type?: string }; status: string }) =>
      action.status === "pending" && action.resume_condition?.type === "github_repository_connected");
    expect(repositoryAction).toMatchObject({
      type: "provider_app_registration",
      assignee_role: "admin",
      fields: [],
    });
    expect(repositorySetup.body.human_actions.some((action: { resume_condition?: { topic?: string }; status: string }) =>
      action.status === "pending" && action.resume_condition?.topic?.startsWith("code_workspace:"))).toBe(false);
    expect(repositorySetup.body.change_sets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "browser_flow",
        status: "planned",
        artifacts: expect.arrayContaining([
          expect.objectContaining({ type: "allowed_domain", name: "compliance.example.test" }),
          expect.objectContaining({ type: "browser_mode", name: "public_ephemeral" }),
        ]),
      }),
    ]));
    expect(repositorySetup.body.human_actions.find((action: { resume_condition?: { topic?: string } }) =>
      action.resume_condition?.topic === "public_x_post").response).toMatchObject({ public_payload: expect.stringContaining("匿名審査ID") });
  });

  it("回答されたOpenAPI URLを自動検査し、Connector生成からPreviewまで再開する", async () => {
    const openapi = {
      openapi: "3.1.0",
      info: { title: `Customer History ${h.suffix}`, version: "1.0.0" },
      servers: [{ url: "https://example.com" }],
      paths: {
        "/history": {
          get: {
            operationId: "getCustomerHistory",
            summary: "問い合わせ履歴",
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      return url.endsWith("/openapi.json")
        ? new Response(JSON.stringify(openapi), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ customer_id: "anonymous-test", inquiries: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      const created = await h.request("POST", "/api/v1/builder-projects", {
        email,
        org: org.id,
        body: { request: "過去の問い合わせ履歴を確認し、結果を日本語で説明するAgentを完成させてください。", target: "preview" },
      });
      const waiting = await h.waitFor(
        () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email, org: org.id }),
        (response) => response.body.status === "waiting_human_action",
      );
      const question = waiting.body.human_actions.find((action: { resume_condition?: { topic?: string }; status: string }) =>
        action.status === "pending" && action.resume_condition?.topic === "past_inquiry_source");
      expect(question).toBeDefined();
      const invalid = await h.request("POST", `/api/v1/builder-human-actions/${question.id}/complete`, {
        email,
        org: org.id,
        body: { answers: { system: "顧客履歴API", lookup_key: "顧客ID", contract_url: "http://internal.example/openapi.json" } },
      });
      expect(invalid.status).toBe(400);
      const answered = await h.request("POST", `/api/v1/builder-human-actions/${question.id}/complete`, {
        email,
        org: org.id,
        body: { answers: { system: "顧客履歴API", lookup_key: "顧客ID", contract_url: "https://example.com/openapi.json" } },
      });
      expect(answered.status, JSON.stringify(answered.body)).toBe(200);

      const completed = await h.waitFor(
        () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email, org: org.id }),
        (response) => ["completed", "failed", "blocked"].includes(response.body.status),
        30_000,
      );
      expect(completed.body.status, JSON.stringify(completed.body)).toBe("completed");
      expect(completed.body.discovery_sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "openapi", source_url: "https://example.com/openapi.json" }),
      ]));
      expect(completed.body.change_sets).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "declarative_connector", status: "applied" }),
      ]));
      expect(completed.body.releases[0]).toMatchObject({ status: "preview_succeeded" });
      expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/openapi.json"))).toBe(true);
      expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/history"))).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("複数の回答から生成したConnectorを同じBuildへ固定する", async () => {
    const document = (title: string, operationId: string, summary: string, path: string) => ({
      openapi: "3.1.0",
      info: { title, version: "1.0.0" },
      servers: [{ url: "https://example.com" }],
      paths: { [path]: { get: { operationId, summary, responses: { "200": { description: "ok" } } } } },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/history-openapi.json")) {
        return new Response(JSON.stringify(document(`History ${h.suffix}`, "getCustomerHistory", "問い合わせ履歴", "/history")), { status: 200 });
      }
      if (url.endsWith("/denied-openapi.json")) {
        return new Response(JSON.stringify(document(`Denied ${h.suffix}`, "checkDeniedCustomer", "審査に落とした人一覧", "/denied")), { status: 200 });
      }
      return new Response(JSON.stringify({ matched: false }), { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      const created = await h.request("POST", "/api/v1/builder-projects", {
        email,
        org: org.id,
        body: { request: "過去の問い合わせ履歴と、自社で審査に落とした人一覧を照合して結果を説明するAgentを完成させてください。", target: "preview" },
      });
      const waiting = await h.waitFor(
        () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email, org: org.id }),
        (response) => response.body.status === "waiting_human_action",
      );
      const byTopic = new Map(waiting.body.human_actions.map((action: { resume_condition?: { topic?: string }; id: string }) => [action.resume_condition?.topic, action.id]));
      expect([...byTopic.keys()]).toEqual(expect.arrayContaining(["past_inquiry_source", "internal_denied_list"]));
      const history = await h.request("POST", `/api/v1/builder-human-actions/${byTopic.get("past_inquiry_source")}/complete`, {
        email,
        org: org.id,
        body: { answers: { system: "履歴API", lookup_key: "顧客ID", contract_url: "https://example.com/history-openapi.json" } },
      });
      expect(history.status).toBe(200);
      const denied = await h.request("POST", `/api/v1/builder-human-actions/${byTopic.get("internal_denied_list")}/complete`, {
        email,
        org: org.id,
        body: { answers: { system: "否決API", match_fields: "法人番号", contract_url: "https://example.com/denied-openapi.json" } },
      });
      expect(denied.status).toBe(200);

      const completed = await h.waitFor(
        () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email, org: org.id }),
        (response) => ["completed", "failed", "blocked"].includes(response.body.status),
        30_000,
      );
      expect(completed.body.status, JSON.stringify(completed.body)).toBe("completed");
      expect(completed.body.discovery_sources).toHaveLength(2);
      expect(completed.body.change_sets.filter((change: { kind: string }) => change.kind === "declarative_connector")).toHaveLength(2);
      expect(completed.body.releases[0].required_tools).toHaveLength(2);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("業務と無関係な契約は生成せず、URLの再回答後に自動復帰する", async () => {
    const spec = (summary: string, operationId: string) => ({
      openapi: "3.1.0",
      info: { title: `Contract relevance ${h.suffix}`, version: "1.0.0" },
      servers: [{ url: "https://example.com" }],
      paths: { "/resource": { get: { operationId, summary, responses: { "200": { description: "ok" } } } } },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/wrong-openapi.json")) return new Response(JSON.stringify(spec("ペット一覧", "listPets")), { status: 200 });
      if (url.endsWith("/right-openapi.json")) return new Response(JSON.stringify(spec("問い合わせ履歴", "getCustomerHistory")), { status: 200 });
      return new Response(JSON.stringify({ inquiries: [] }), { status: 200 });
    });
    try {
      const created = await h.request("POST", "/api/v1/builder-projects", {
        email,
        org: org.id,
        body: { request: "過去の問い合わせ履歴を取得して説明するAgentを完成させてください。", target: "preview" },
      });
      const firstWaiting = await h.waitFor(
        () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email, org: org.id }),
        (response) => response.body.status === "waiting_human_action",
      );
      const source = firstWaiting.body.human_actions.find((action: { resume_condition?: { topic?: string }; status: string }) =>
        action.status === "pending" && action.resume_condition?.topic === "past_inquiry_source");
      await h.request("POST", `/api/v1/builder-human-actions/${source.id}/complete`, {
        email,
        org: org.id,
        body: { answers: { system: "履歴API", lookup_key: "顧客ID", contract_url: "https://example.com/wrong-openapi.json" } },
      });

      const retryWaiting = await h.waitFor(
        () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email, org: org.id }),
        (response) => response.body.status === "waiting_human_action"
          && response.body.human_actions.some((action: { resume_condition?: { topic?: string }; status: string }) => action.status === "pending" && action.resume_condition?.topic?.startsWith("contract_retry:")),
        30_000,
      );
      expect(retryWaiting.body.discovery_sources).toHaveLength(0);
      expect(retryWaiting.body.validation_runs).toEqual(expect.arrayContaining([
        expect.objectContaining({ suite: "discovery", status: "failed", error: expect.stringContaining("対応するOpenAPI操作") }),
      ]));
      const retry = retryWaiting.body.human_actions.find((action: { resume_condition?: { topic?: string }; status: string }) =>
        action.status === "pending" && action.resume_condition?.topic?.startsWith("contract_retry:"));
      const corrected = await h.request("POST", `/api/v1/builder-human-actions/${retry.id}/complete`, {
        email,
        org: org.id,
        body: { answers: { contract_url: "https://example.com/right-openapi.json" } },
      });
      expect(corrected.status).toBe(200);
      const completed = await h.waitFor(
        () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email, org: org.id }),
        (response) => ["completed", "failed", "blocked"].includes(response.body.status),
        30_000,
      );
      expect(completed.body.status, JSON.stringify(completed.body)).toBe("completed");
      expect(completed.body.discovery_sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ source_url: "https://example.com/right-openapi.json" }),
      ]));
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("OpenAPIを検査してConnector・Tool・契約証跡を生成する", async () => {
    const created = await h.request("POST", "/api/v1/builder-projects", {
      email,
      org: org.id,
      body: { request: "公開されている請求書APIから請求書を読み取り、担当者が確認できるAgentを作成してください。", target: "preview" },
    });
    const project = await h.waitFor(
      () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email, org: org.id }),
      (response) => response.body.runs[0]?.status === "completed",
    );
    expect(project.status).toBe(200);

    const openapi = {
      openapi: "3.1.0",
      info: { title: `Invoice ${h.suffix}`, version: "1.0.0" },
      servers: [{ url: "https://api.example.com/v1" }],
      security: [{ ApiKey: [] }],
      components: { securitySchemes: { ApiKey: { type: "apiKey", in: "header", name: "X-Api-Key" } } },
      paths: {
        "/invoices/{invoice_id}": {
          get: {
            operationId: "getInvoice",
            summary: "請求書を取得",
            parameters: [{ name: "invoice_id", in: "path", required: true, schema: { type: "string" } }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const inspect = await h.request("POST", `/api/v1/builder-projects/${created.body.id}/openapi/inspect`, {
      email,
      org: org.id,
      body: { document: openapi, connector_key: `invoice-${h.suffix}` },
    });
    expect(inspect.status).toBe(200);
    expect(inspect.body.operations).toHaveLength(1);
    expect(inspect.body.operations[0]).toMatchObject({ risk: "read", method: "GET", path: "/invoices/{invoice_id}" });

    const applied = await h.request("POST", `/api/v1/builder-projects/${created.body.id}/openapi/apply`, {
      email,
      org: org.id,
      body: { document: openapi, connector_key: `invoice-${h.suffix}` },
    });
    expect(applied.status).toBe(201);
    expect(applied.body.connector.tools).toHaveLength(1);
    expect(applied.body.project.status).toBe("waiting_human_action");
    expect(applied.body.project.discovery_sources).toHaveLength(1);
    expect(applied.body.project.change_sets.find((change: { kind: string }) => change.kind === "declarative_connector"))
      .toMatchObject({ kind: "declarative_connector", status: "applied", risk: "read" });
    expect(applied.body.project.validation_runs.map((run: { suite: string; status: string }) => [run.suite, run.status])).toEqual(
      expect.arrayContaining([["contract", "passed"], ["security", "passed"]]),
    );
    expect(applied.body.project.human_actions[0]).toMatchObject({ type: "enter_secret", status: "pending" });
  });

  it("認証不要の読取OpenAPIからAgent・Build・実Runを作り、Tool成功後だけ完了する", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ status: "ok", source: "public-api" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    try {
      const created = await h.request("POST", "/api/v1/builder-projects", {
        email,
        org: org.id,
        body: { request: "公開Status APIのgetPublicStatus操作を実行し、取得結果を日本語で説明するAgentを完成させてください。", target: "preview" },
      });
      await h.waitFor(
        () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email, org: org.id }),
        (response) => response.body.runs[0]?.status === "completed",
      );
      const openapi = {
        openapi: "3.1.0",
        info: { title: `Public Status ${h.suffix}`, version: "1.0.0" },
        servers: [{ url: "https://example.com" }],
        paths: {
          "/status": {
            get: {
              operationId: "getPublicStatus",
              summary: "公開ステータスを取得",
              responses: { "200": { description: "ok" } },
            },
          },
        },
      };
      const applied = await h.request("POST", `/api/v1/builder-projects/${created.body.id}/openapi/apply`, {
        email,
        org: org.id,
        body: { document: openapi, connector_key: `public-status-${h.suffix}` },
      });
      expect(applied.status, JSON.stringify(applied.body)).toBe(201);
      const completed = await h.waitFor(
        () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email, org: org.id }),
        (response) => ["completed", "failed"].includes(response.body.status),
        30_000,
      );
      expect(completed.body.status, JSON.stringify(completed.body)).toBe("completed");
      expect(completed.body.releases[0]).toMatchObject({ status: "preview_succeeded", preview_run_id: expect.any(String) });
      expect(completed.body.validation_runs).toEqual(expect.arrayContaining([
        expect.objectContaining({ suite: "preview", status: "passed" }),
      ]));
      const run = await h.request("GET", `/api/v1/runs/${completed.body.releases[0].preview_run_id}`, { email, org: org.id });
      expect(run.body).toMatchObject({ status: "completed", outcome: "succeeded" });
      expect(fetchMock).toHaveBeenCalled();

      const previewDeployment = await h.admin.deployments.findUniqueOrThrow({
        where: { id: completed.body.releases[0].preview_deployment_id },
      });
      const compiled = previewDeployment.compiled_config as unknown as {
        function_tools?: Array<{ name?: string }>;
      };
      const deployedToolName = compiled.function_tools?.find((tool) => typeof tool.name === "string")?.name;
      expect(deployedToolName, JSON.stringify(compiled)).toBeTruthy();

      const workflow = await h.request("POST", "/api/v1/workflows", {
        email,
        org: org.id,
        body: {
          key: `builder-tool-result-${h.suffix}`,
          name: "Builder Tool結果引き渡し",
          definition: {
            version: 2,
            start: "read-status",
            steps: [{
              type: "tool",
              key: "read-status",
              name: "公開Statusを取得",
              deployment_id: completed.body.releases[0].preview_deployment_id,
              tool_name: deployedToolName,
              arguments_template: "{}",
            }],
          },
        },
      });
      expect(workflow.status, JSON.stringify(workflow.body)).toBe(201);
      const workflowRun = await h.request("POST", `/api/v1/workflows/${workflow.body.id}/runs`, {
        email,
        org: org.id,
        body: { input: "{}" },
      });
      const workflowCompleted = await h.waitFor(
        () => h.request("GET", `/api/v1/workflow-runs/${workflowRun.body.id}`, { email, org: org.id }),
        (response) => response.body.status === "completed" || response.body.status === "failed",
        30_000,
      );
      expect(workflowCompleted.body.status, JSON.stringify(workflowCompleted.body)).toBe("completed");
      expect(JSON.parse(workflowCompleted.body.steps[0].output)).toMatchObject({ status: "ok", source: "public-api" });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("MCP DiscoveryからSchema付きToolを生成し、MCP Call成功までPreviewを完了する", async () => {
    const created = await h.request("POST", "/api/v1/builder-projects", {
      email,
      org: org.id,
      body: { request: "公開MCPのsearch-docs操作を使い、ドキュメントの検索結果を報告するAgentを完成させてください。", target: "preview" },
    });
    await h.waitFor(
      () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email, org: org.id }),
      (response) => response.body.runs[0]?.status === "completed",
    );
    const input = {
      server_url: "https://mcp.example.com/mcp",
      connector_key: `docs-mcp-${h.suffix}`,
      auth_type: "none",
    };
    const inspected = await h.request("POST", `/api/v1/builder-projects/${created.body.id}/mcp/inspect`, {
      email,
      org: org.id,
      body: input,
    });
    expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
    expect(inspected.body.operations[0]).toMatchObject({ remote_name: "search-docs", risk: "read" });
    expect(inspected.body.operations[0].input_schema).toMatchObject({ required: ["query"] });

    const applied = await h.request("POST", `/api/v1/builder-projects/${created.body.id}/mcp/apply`, {
      email,
      org: org.id,
      body: { ...input, selected_tool_names: ["search-docs"], expected_content_hash: inspected.body.source.content_hash },
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    expect(applied.body.connector).toMatchObject({ adapter: "mcp", auth_type: "none" });
    expect(applied.body.project.discovery_sources[0]).toMatchObject({ kind: "mcp", spec_version: "MCP" });

    const completed = await h.waitFor(
      () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email, org: org.id }),
      (response) => ["completed", "failed"].includes(response.body.status),
      30_000,
    );
    expect(completed.body.status, JSON.stringify(completed.body)).toBe("completed");
    expect(completed.body.releases[0]).toMatchObject({ status: "preview_succeeded", preview_run_id: expect.any(String) });
    expect(completed.body.validation_runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ suite: "contract", status: "passed" }),
      expect.objectContaining({ suite: "security", status: "passed" }),
      expect.objectContaining({ suite: "smoke", status: "passed" }),
      expect.objectContaining({ suite: "preview", status: "passed" }),
    ]));
    const tool = await h.admin.tools.findFirstOrThrow({ where: { organization_id: org.id, name: applied.body.connector.tools[0].name }, include: { versions: true } });
    expect(tool.versions[0]?.spec).toMatchObject({
      execution_location: "openai_service_mcp",
      input_schema: { required: ["query"] },
      service_mcp: { allowed_tools: ["search-docs"] },
    });
  });

  it("管理者承認後にPreviewと同一BuildをProductionへ昇格し限定Runまで完了する", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const created = await h.request("POST", "/api/v1/builder-projects", {
        email,
        org: org.id,
        body: { request: "公開Health APIを読み取り、管理者承認後に同じBuildをProductionへ昇格するAgentを完成させてください。", target: "production" },
      });
      await h.waitFor(
        () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email, org: org.id }),
        (response) => response.body.runs[0]?.status === "completed",
      );
      const openapi = {
        openapi: "3.1.0",
        info: { title: `Production Health ${h.suffix}`, version: "1.0.0" },
        servers: [{ url: "https://example.com" }],
        paths: { "/health": { get: { operationId: "getProductionHealth", summary: "Healthを取得", responses: { "200": { description: "ok" } } } } },
      };
      const applied = await h.request("POST", `/api/v1/builder-projects/${created.body.id}/openapi/apply`, {
        email,
        org: org.id,
        body: { document: openapi, connector_key: `production-health-${h.suffix}` },
      });
      expect(applied.status).toBe(201);
      const pending = await h.waitFor(
        () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email, org: org.id }),
        (response) => response.body.status === "production_pending_approval" || response.body.status === "failed",
        30_000,
      );
      expect(pending.body.status, JSON.stringify(pending.body)).toBe("production_pending_approval");
      expect(pending.body.releases[0].status).toBe("production_pending_approval");
      expect(pending.body.human_actions).toEqual(expect.arrayContaining([expect.objectContaining({ type: "production_approval", status: "pending" })]));

      const approved = await h.request("POST", `/api/v1/builder-projects/${created.body.id}/production/approve`, { email: adminEmail, org: org.id });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(approved.body.releases[0]).toMatchObject({ status: "production_running", production_deployment_id: expect.any(String), production_run_id: expect.any(String) });
      expect(approved.body.releases[0].build_id).toBe(pending.body.releases[0].build_id);
      const [previewRun, productionRun] = await Promise.all([
        h.admin.runs.findUniqueOrThrow({ where: { id: pending.body.releases[0].preview_run_id } }),
        h.admin.runs.findUniqueOrThrow({ where: { id: approved.body.releases[0].production_run_id } }),
      ]);
      expect(productionRun.input).toContain(previewRun.input);

      const completed = await h.waitFor(
        () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email, org: org.id }),
        (response) => response.body.status === "completed" || response.body.status === "failed",
        30_000,
      );
      expect(completed.body.status, JSON.stringify(completed.body)).toBe("completed");
      expect(completed.body.releases[0].status).toBe("production_succeeded");
      expect(completed.body.validation_runs).toEqual(expect.arrayContaining([expect.objectContaining({ environment: "production", status: "passed" })]));
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("組織Policy内ならPreview成功後に同一BuildをProductionへ自動昇格する", async () => {
    const autoEmail = `builder-auto-production-${h.suffix}@example.com`;
    const autoOrg = await h.createOrg("builder-auto-production", [{ email: autoEmail, role: "owner", approver: true }]);
    await h.admin.runtime_profiles.create({ data: { organization_id: autoOrg.id, key: "builder-preview", name: "Builder Preview", type: "openai_hosted" } });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const created = await h.request("POST", "/api/v1/builder-projects", {
        email: autoEmail,
        org: autoOrg.id,
        body: { request: "公開Health APIを読み取り、許可済みPolicyで同じBuildをProductionまで自動昇格するAgentを完成させてください。", target: "production" },
      });
      await h.waitFor(
        () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email: autoEmail, org: autoOrg.id }),
        (response) => response.body.runs[0]?.status === "completed",
      );
      const openapi = {
        openapi: "3.1.0",
        info: { title: `Auto Production Health ${h.suffix}`, version: "1.0.0" },
        servers: [{ url: "https://example.com" }],
        paths: { "/health": { get: { operationId: "getAutoProductionHealth", summary: "Healthを取得", responses: { "200": { description: "ok" } } } } },
      };
      const inspected = await h.request("POST", `/api/v1/builder-projects/${created.body.id}/openapi/inspect`, {
        email: autoEmail,
        org: autoOrg.id,
        body: { document: openapi, connector_key: `auto-production-health-${h.suffix}` },
      });
      expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
      const toolName = inspected.body.operations[0].name as string;
      const policy = await h.request("PUT", "/api/v1/organization/auto-approval-policy", {
        email: autoEmail,
        org: autoOrg.id,
        body: {
          mode: "all_within_policy",
          environments: ["staging", "production"],
          allowed_hosts: ["example.com"],
          allowed_operations: [toolName, "production_promotion"],
          allowed_methods: ["GET"],
          denied_methods: ["DELETE"],
          limits: { requests_per_minute: 100, daily_cost_jpy: null, max_records_per_call: 100 },
          production_promotion: true,
          automatic_retry: true,
          automatic_rollback: true,
          expires_at: null,
        },
      });
      expect(policy.status, JSON.stringify(policy.body)).toBe(200);
      const applied = await h.request("POST", `/api/v1/builder-projects/${created.body.id}/openapi/apply`, {
        email: autoEmail,
        org: autoOrg.id,
        body: { document: openapi, connector_key: `auto-production-health-${h.suffix}` },
      });
      expect(applied.status, JSON.stringify(applied.body)).toBe(201);

      const completed = await h.waitFor(
        () => h.request("GET", `/api/v1/builder-projects/${created.body.id}`, { email: autoEmail, org: autoOrg.id }),
        (response) => response.body.status === "completed" || response.body.status === "failed" || response.body.status === "blocked",
        30_000,
      );
      expect(completed.body.status, JSON.stringify(completed.body)).toBe("completed");
      expect(completed.body.releases[0]).toMatchObject({ status: "production_succeeded", production_run_id: expect.any(String) });
      expect(completed.body.human_actions).toEqual(expect.arrayContaining([expect.objectContaining({ type: "production_approval", status: "completed" })]));
      const approval = await h.admin.approvals.findFirstOrThrow({ where: { organization_id: autoOrg.id, tool: "production_promotion" } });
      expect(approval).toMatchObject({ auto_approved: true, status: "consumed", auto_approval_policy_version: 1 });
      const audit = await h.admin.audit_logs.findFirstOrThrow({ where: { organization_id: autoOrg.id, action: "builder.production.auto_promote" } });
      expect(audit.result).toBe("success");
    } finally {
      fetchMock.mockRestore();
    }
  });
});
