import { describe, expect, it } from "vitest";
import { toManifestDraft } from "../application/agents.js";
import { workflowDefinitionSchema } from "@agent-studio/contracts";
import { buildFactoringWorkflow, codeWorkspaceQuestionsFor, ensureAnsweredSourceRequirements, ensureRequiredScenarioTools, explicitOrganizationToolDraft, humanCapabilityRequirements, intakeQuestionsFor, organizationCodeWorkspaceQuestionsFor } from "./builder-orchestrator.js";
import { judge, renderArgumentsTemplate, renderTemplate } from "./engines.js";
import { isPrivateAddress } from "./studio-functions.js";

describe("isPrivateAddress（SSRF 対策）", () => {
  it.each(["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.5", "192.168.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"])(
    "内部: %s",
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
  it.each(["8.8.8.8", "52.95.1.1", "2606:4700::1111"])("公開: %s", (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe("renderTemplate（Workflow）", () => {
  it("入力と前のステップの出力を埋め込む", () => {
    const steps = [{ key: "research", type: "agent" as const, status: "completed" as const, run_id: "r", approval_id: null, output: "調査結果", attempts: 1, resume_at: null }];
    expect(renderTemplate("依頼: {{input}} / 結果: {{ steps.research.output }} / {{steps.none.output}}", "価格", steps)).toBe(
      "依頼: 価格 / 結果: 調査結果 / ",
    );
  });

  it("JSON出力のpathを公開用の文字列へ安全に展開する", () => {
    const steps = [{ key: "rule", type: "tool" as const, status: "completed" as const, run_id: "r", approval_id: null, output: '{"decision_candidate":"可","reason_summary":"AMOUNT_OK,BANK_HISTORY_OK"}', attempts: 1, resume_at: null }];
    expect(renderTemplate("審査結果: {{steps.rule.output.decision_candidate}}, 理由: {{steps.rule.output.reason_summary}}", "{}", steps)).toBe(
      "審査結果: 可, 理由: AMOUNT_OK,BANK_HISTORY_OK",
    );
  });

  it("型付き入力・Tool出力・Workflow Run IDをJSON値として埋め込む", () => {
    const steps = [{ key: "rule", type: "tool" as const, status: "completed" as const, run_id: "r", approval_id: null, output: '{"decision_candidate":"可","reason_codes":["OK"]}', attempts: 1, resume_at: null }];
    const rendered = renderArgumentsTemplate(
      '{"invoice_id":{{input.application_id}},"decision":{{steps.rule.output.decision_candidate}},"codes":{{steps.rule.output.reason_codes}},"idempotency_key":{{workflow_run_id}}}',
      '{"application_id":"INV-1"}',
      steps,
      "run-1",
    );
    expect(JSON.parse(rendered)).toEqual({ invoice_id: "INV-1", decision: "可", codes: ["OK"], idempotency_key: "run-1" });
  });
});

describe("Builder factoring workflow", () => {
  it("最新情報にはOpenAI標準Web Searchを必須化し、画像生成不足も取りこぼさない", () => {
    const resolution = ensureRequiredScenarioTools(
      "今日の最新テックニュースをまとめ、挿絵を生成して投稿する",
      { requirements: [], selected_tools: [], missing_variables: [], ready: true },
      [],
    );
    expect(resolution.selected_tools).toContain("web_search");
    expect(resolution.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "resolved", tool_names: ["web_search"] }),
      expect.objectContaining({ state: "missing", requirement: expect.stringMatching(/画像/) }),
    ]));
    expect(resolution.ready).toBe(false);
  });

  it("曖昧な公開情報の調査にもWeb Searchを自動で割り当てる", () => {
    const resolution = ensureRequiredScenarioTools(
      "競合サービスの評判と価格をWebで調べて比較する",
      { requirements: [], selected_tools: [], missing_variables: [], ready: true },
      [],
    );
    expect(resolution.selected_tools).toContain("web_search");
    expect(resolution.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "resolved", tool_names: ["web_search"] }),
    ]));
  });

  it("共通画像Toolが登録済みなら不足扱いせず、接続状態まで能力計画へ反映する", () => {
    const resolution = ensureRequiredScenarioTools(
      "ニュース用の挿絵画像を生成する",
      { requirements: [], selected_tools: [], missing_variables: [], ready: true },
      [{
        name: "generate_social_image",
        displayName: "投稿用画像を生成",
        description: "OpenAIで画像を生成しSocial Routerへ保存する",
        connectorId: "social-router",
        connectorName: "Social Router",
        ready: false,
      }],
    );
    expect(resolution.selected_tools).toContain("generate_social_image");
    expect(resolution.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "needs_connection", tool_names: ["generate_social_image"] }),
    ]));
    expect(resolution.ready).toBe(false);
  });

  it("ファクタリングとX投稿の必須Toolをモデルの候補漏れから補完する", () => {
    const names = ["list_applications", "get_application", "analyze_bank_statement", "check_compliance", "evaluate_factoring_rules", "record_screening", "list_accounts", "publish_post", "get_job"];
    const resolution = ensureRequiredScenarioTools(
      "ファクタリング審査結果を検証用Xアカウントへ投稿する",
      { requirements: [], selected_tools: [], missing_variables: [], ready: true },
      names.map((name) => ({
        name,
        displayName: name,
        description: `${name} description`,
        connectorId: name === "publish_post" ? "social-router" : "runtime",
        connectorName: name === "publish_post" ? "Social Router" : "Runtime Tool Catalog",
        ready: name !== "publish_post",
      })),
    );
    expect(resolution.selected_tools).toEqual(expect.arrayContaining(names));
    expect(resolution.requirements.find((requirement) => requirement.tool_names.includes("publish_post"))?.state).toBe("needs_connection");
    expect(resolution.requirements.find((requirement) => requirement.tool_names.includes("evaluate_factoring_rules"))?.state).toBe("resolved");
    expect(resolution.ready).toBe(false);
  });

  it("必要Toolが揃うと条件分岐・承認・冪等書き戻しを持つv2定義を生成する", () => {
    const workflow = buildFactoringWorkflow(
      ["get_application", "analyze_bank_statement", "factoring_check_compliance", "evaluate_factoring_rules", "record_screening"],
      "00000000-0000-4000-8000-000000000001",
    );
    expect(workflowDefinitionSchema.parse(workflow).version).toBe(2);
    expect(workflow?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "condition", key: "route-decision" }),
      expect.objectContaining({ type: "approval", key: "approve-result" }),
      expect.objectContaining({ type: "tool", key: "record-result", arguments_template: expect.stringContaining("workflow_run_id") }),
    ]));
  });

  it("能力が不足していると不完全なWorkflowを生成しない", () => {
    expect(buildFactoringWorkflow(["get_application"], "00000000-0000-4000-8000-000000000001")).toBeNull();
  });

  it("X投稿を指定すると匿名化した本文・冪等ID・非同期結果確認ToolをBuildに要求する", () => {
    const workflow = buildFactoringWorkflow(
      ["get_application", "analyze_bank_statement", "check_compliance", "evaluate_factoring_rules", "record_screening", "publish_post", "get_job"],
      "00000000-0000-4000-8000-000000000001",
      { xAccountId: "x-account-1" },
    );
    expect(workflowDefinitionSchema.parse(workflow).version).toBe(2);
    expect(workflow?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "transform", key: "public-summary", output_template: expect.not.stringContaining("company") }),
      expect.objectContaining({ type: "approval", key: "approve-publication", message: expect.stringContaining("最終本文") }),
      expect.objectContaining({ type: "condition", key: "route-publication", condition: expect.objectContaining({ path: "decision_code", operator: "ne", value: "reject" }) }),
      expect.objectContaining({ type: "tool", key: "publish-result", tool_name: "publish_post", arguments_template: expect.stringContaining("workflow_run_id") }),
    ]));
    expect(JSON.stringify(workflow)).not.toContain("customer_name");
  });

  it("X投稿の完了確認ToolがないBuildでは投稿付きWorkflowを生成しない", () => {
    expect(buildFactoringWorkflow(
      ["get_application", "analyze_bank_statement", "check_compliance", "evaluate_factoring_rules", "record_screening", "publish_post"],
      "00000000-0000-4000-8000-000000000001",
      { xAccountId: "x-account-1" },
    )).toBeNull();
  });
});

describe("Builder conversational intake", () => {
  it("企業専用バックエンドの明示依頼は外部モデルなしでRepository準備へ進める", () => {
    const draft = explicitOrganizationToolDraft(
      "A社専用バックエンドを作り、社内サーバーの顧客DBへA社Runtimeから接続する",
      "12345678-0000-4000-8000-000000000001",
    );
    expect(draft?.notes).toContain("企業専用バックエンドの明示依頼を検出し、Repository準備へ決定的に進めました");
    expect(draft?.resolution.requirements).toEqual([
      expect.objectContaining({ state: "missing", requirement: expect.stringMatching(/企業専用Runtime/) }),
    ]);
    expect(explicitOrganizationToolDraft("公開Webのニュースを要約する", "project-id")).toBeNull();
  });

  it("一般化されていない社内システム能力を企業専用RepositoryのCode Workspaceへ送る", () => {
    const questions = organizationCodeWorkspaceQuestionsFor("社内専用の基幹システムへ接続したい", [], [{
      requirement: "基幹システムから在庫引当状況を取得する",
      state: "missing",
      connector_id: null,
      connector_name: null,
      tool_names: [],
      confidence: 1,
      reason: "既存Toolなし",
      variables: [],
      fulfillment: {
        mode: "organization_tool",
        owner: "organization",
        execution_location: "runtime",
        reason: "企業専用Runtimeへ実装",
        availability_target_minutes: null,
      },
    }]);
    expect(questions).toHaveLength(1);
    expect(questions[0]?.topic).toMatch(/^code_workspace:organization_[a-f0-9]{12}$/);
    expect(questions[0]?.fields.map((field) => field.name)).toEqual(["repository_url", "adapter_path", "interface_notes"]);
  });

  it("ファクタリング依頼から推測してはいけない業務事実だけを質問にする", () => {
    const questions = intakeQuestionsFor("過去の問い合わせ履歴を確認します。口座写画像はファイルサーバーにあります。反社一覧サイトと自社で審査に落とした人一覧を照合し、100万円以上は冗長のパスです。最後に結果をXに投稿します。");
    expect(questions.map((question) => question.topic)).toEqual([
      "past_inquiry_source",
      "bank_document_source",
      "compliance_source",
      "internal_denied_list",
      "over_limit_route",
      "public_x_post",
    ]);
    expect(questions.find((question) => question.topic === "public_x_post")?.reason).toContain("個人・企業を特定できる情報を除外");
    expect(questions.find((question) => question.topic === "compliance_source")?.fields.find((field) => field.name === "access_method")?.options).toEqual([
      { value: "public_web", label: "ログイン不要の公開サイト" },
      { value: "human_login", label: "人によるログインが必要" },
      { value: "runtime_tool", label: "許可済みRuntime Tool（Mockを含む）" },
    ]);
    expect(questions.flatMap((question) => question.fields).every((field) => field.secret === false)).toBe(true);
  });

  it("許可済みMock反社照合と検証用Xアカウントを質問として取りこぼさない", () => {
    const questions = intakeQuestionsFor("許可済みMock反社照合を使い、匿名結果だけを検証用Xアカウントへ最終承認後に投稿する。");
    expect(questions.map((question) => question.topic)).toEqual(["compliance_source", "public_x_post"]);
    expect(questions.find((question) => question.topic === "compliance_source")?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "runtime_tool" }),
    ]));
  });

  it("具体的な参照先の質問中は推測したConnector接続を重複表示しない", () => {
    const intake = intakeQuestionsFor("過去の問い合わせ履歴を確認してください");
    const gaps = [
      { requirement: "過去の問い合わせ履歴を顧客検索デモで確認", state: "needs_connection" as const, connector_id: null, connector_name: "顧客検索デモ", tool_names: [], reason: "接続なし", confidence: 1, variables: [] },
      { requirement: "請求書を会計システムへ記録", state: "needs_connection" as const, connector_id: null, connector_name: "会計", tool_names: [], reason: "接続なし", confidence: 1, variables: [] },
    ];
    expect(humanCapabilityRequirements(gaps, intake).map((gap) => gap.connector_name)).toEqual(["会計"]);
    expect(humanCapabilityRequirements(gaps, []).map((gap) => gap.connector_name)).toEqual(["顧客検索デモ", "会計"]);
  });

  it("実装先まで判定済みの不足能力について連携方法を再確認しない", () => {
    const gaps = [{
      requirement: "社内DBから契約状況を取得する",
      state: "ambiguous" as const,
      connector_id: null,
      connector_name: null,
      tool_names: [],
      reason: "企業専用Toolを生成する",
      confidence: 1,
      variables: [],
      fulfillment: { mode: "organization_tool" as const, owner: "organization" as const, execution_location: "runtime" as const, reason: "企業専用Runtimeへ実装", availability_target_minutes: null },
    }];
    expect(humanCapabilityRequirements(gaps, [])).toEqual([]);
  });

  it("回答済みの社内データ源をLLMが落としても不足能力として保持する", () => {
    const answered = [{
      title: "過去の問い合わせ履歴の参照先を教えてください",
      response: { system: "社内DB", lookup_key: "法人番号" },
      resume_condition: { type: "builder_answers", topic: "past_inquiry_source" },
    }];
    const requirements = ensureAnsweredSourceRequirements(answered, []);
    expect(requirements).toEqual([expect.objectContaining({ state: "missing", requirement: expect.stringContaining("問い合わせ履歴") })]);
  });

  it("Heartbeatで報告済みのRuntime Toolを明示した能力はAdapter生成を要求しない", () => {
    const answered = [{
      title: "口座画像の取得元を教えてください",
      response: { document_source: "Runtime内fixture", runtime_tool: "analyze_bank_statement" },
      resume_condition: { type: "builder_answers", topic: "bank_document_source" },
    }];
    const requirements = ensureAnsweredSourceRequirements(answered, []);
    expect(requirements).toEqual([expect.objectContaining({ state: "resolved", tool_names: ["analyze_bank_statement"] })]);
    expect(codeWorkspaceQuestionsFor(answered, requirements)).toHaveLength(0);
  });

  it("既存Social Router投稿Toolが解決済みなら古いX投稿不足を除去する", () => {
    const answered = [{
      title: "Xへ公開してよい内容とアカウントを確認してください",
      response: { account_id: "acc-test", integration: "Social Router Connector" },
      resume_condition: { type: "builder_answers", topic: "public_x_post" },
    }];
    const requirements = ensureAnsweredSourceRequirements(answered, [
      {
        requirement: "明示承認された本文を指定アカウントへ非同期で投稿する",
        state: "resolved",
        connector_id: "connector-1",
        connector_name: "Social Router",
        tool_names: ["publish_post"],
        confidence: 1,
        reason: "既存Tool",
        variables: [],
      },
      {
        requirement: "匿名化した審査結果を冪等に投稿し完了状態を取得する",
        state: "missing",
        connector_id: null,
        connector_name: null,
        tool_names: [],
        confidence: 1,
        reason: "以前の不足判定",
        variables: [],
      },
    ]);
    expect(requirements).toEqual([expect.objectContaining({ state: "resolved", tool_names: ["publish_post"] })]);
    expect(codeWorkspaceQuestionsFor(answered, requirements)).toHaveLength(0);
  });

  it("契約も既存Toolもない場合だけ隔離Code Workspaceの入力を求める", () => {
    const answered = [{
      title: "自社の否決一覧の参照方法を教えてください",
      response: { system: "社内ファイルサーバー", match_fields: "法人番号" },
      resume_condition: { type: "builder_answers", topic: "internal_denied_list" },
    }];
    const missing = ensureAnsweredSourceRequirements(answered, []);
    const questions = codeWorkspaceQuestionsFor(answered, missing);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ sourceTopic: "internal_denied_list", topic: "code_workspace:internal_denied_list" });
    expect(questions[0]?.fields.map((field) => field.name)).toEqual(["repository_url", "adapter_path", "interface_notes"]);
    expect(codeWorkspaceQuestionsFor(answered, missing, new Set(["internal_denied_list"]))).toHaveLength(0);
  });

  it("OpenAPI URLまたは解決済みToolがある能力にはCode Workspaceを重複要求しない", () => {
    const withContract = [{
      title: "問い合わせ履歴",
      response: { contract_url: "https://example.com/openapi.json" },
      resume_condition: { topic: "past_inquiry_source" },
    }];
    expect(codeWorkspaceQuestionsFor(withContract, [])).toHaveLength(0);
    const answered = [{
      title: "問い合わせ履歴",
      response: { system: "CRM" },
      resume_condition: { topic: "past_inquiry_source" },
    }];
    expect(codeWorkspaceQuestionsFor(answered, [{
      requirement: "過去の問い合わせ履歴を取得",
      state: "resolved",
      connector_id: null,
      connector_name: null,
      tool_names: ["get_history"],
      confidence: 1,
      reason: "既存Tool",
      variables: [],
    }])).toHaveLength(0);
  });
});

describe("judge（Eval）", () => {
  it("含む・含まないを判定する", () => {
    expect(judge("completed", "価格を400円下げました", null, { must_contain: ["400円"], must_not_contain: ["エラー"] })).toEqual([]);
    expect(judge("completed", "エラーです", null, { must_contain: ["400円"], must_not_contain: ["エラー"] })).toHaveLength(2);
    expect(judge("failed", "", "timeout", undefined)[0]).toContain("timeout");
  });
});

describe("toManifestDraft（日本語 → Manifest）", () => {
  it("存在しないツールを外し、承認条件をポリシーにする", () => {
    const draft = toManifestDraft(
      {
        key: "pricing-agent",
        name: "価格変更",
        description: "価格を変える",
        instructions: "価格を変更する",
        conditional_approvals: [{ tool: "update_price", field: "price_change", op: ">", value: 500, abs: true, reason: "金額が大きい" }],
      },
      new Set(["get_product", "update_price"]),
      new Set(["sample-a-production"]),
      // 使う能力はリゾルバの結果から決まる
      {
        requirements: [],
        selected_tools: ["get_product", "update_price", "unknown_tool"],
        missing_variables: [],
        ready: true,
      },
      "sample-a-production",
    );
    expect(draft.manifest_yaml).toContain("update_price");
    expect(draft.manifest_yaml).not.toContain("unknown_tool");
    expect(draft.manifest_yaml).toContain("price_change");
    expect(draft.notes.some((n) => n.includes("unknown_tool"))).toBe(true);
  });

  it("キーの形式が正しくなければ置き換える", () => {
    const draft = toManifestDraft(
      { key: "Pricing Agent!", name: "", description: "", instructions: "x", conditional_approvals: [] },
      new Set(),
      new Set(),
    );
    expect(draft.manifest_yaml).toContain("key: new-agent");
  });
});
