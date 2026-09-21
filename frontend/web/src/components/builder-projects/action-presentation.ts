import type { HumanActionDto } from "@agent-studio/contracts";

export interface BuilderActionPresentation {
  title: string;
  reason: string;
  fields: HumanActionDto["fields"];
  instructions: string[];
  isImplementationApproval: boolean;
  requiresRepositoryChange: boolean;
  primaryActionLabel: string;
  implementation: null | {
    name: string;
    outcome: string;
    destination: string;
    changes: string[];
    safety: string[];
  };
}

function inferProposal(request: string | undefined, fallback: string) {
  const normalized = request?.replace(/\s+/g, " ").trim() ?? "";
  const explicitRead = normalized.match(/(?:から|、|\s)([^。、\n]{1,50})で([^。、\n]{1,100})だけを(?:読み取|取得)/);
  if (explicitRead) return `${explicitRead[1]!.trim()}で検索し、${explicitRead[2]!.trim()}だけを取得する。登録・更新はしない。`;
  return fallback;
}

function implementationName(topic: string, request: string | undefined) {
  const text = `${topic} ${request ?? ""}`;
  if (/ベンチマーク|過去投稿|SNS|public_x_post/i.test(text)) return "SNS投稿分析用データ取得Tool";
  if (/契約|contract/i.test(text)) return "契約情報取得Tool";
  if (/口座|通帳|bank/i.test(text)) return "口座情報取得Tool";
  if (/問い合わせ|inquiry/i.test(text)) return "過去問い合わせ取得Tool";
  if (/コンプライアンス|反社|compliance/i.test(text)) return "コンプライアンス確認Tool";
  return "社内システム連携Tool";
}

function implementationDestination(instructions: string[]) {
  for (const instruction of instructions) {
    const connected = instruction.match(/接続済みの\s+(.+?)\s+を実装先/);
    if (connected?.[1]) return `${connected[1]} の専用branch`;
    const repository = instruction.match(/(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)/i);
    if (repository?.[1]) return `${repository[1]} の専用branch`;
  }
  return "接続済みGitHub Repositoryの専用branch";
}

/** 保存済みの技術用語を含むHuman Actionも、利用者が答えられる業務用語で表示する。 */
export function presentBuilderAction(action: HumanActionDto, projectRequest?: string): BuilderActionPresentation {
  const condition = action.resume_condition && typeof action.resume_condition === "object" && !Array.isArray(action.resume_condition)
    ? action.resume_condition as { topic?: unknown; interface_notes?: unknown; repository_url?: unknown; repository_connection_id?: unknown }
    : {};
  const codeWorkspace = typeof condition.topic === "string" && condition.topic.startsWith("code_workspace:");
  const hasGitHubProvisioningSource = typeof condition.repository_connection_id === "string";
  if (action.type === "provider_app_registration" && (action.resume_condition as { type?: unknown } | null)?.type === "github_repository_connected") return {
    title: hasGitHubProvisioningSource ? "企業専用Integration Repositoryを自動準備します" : "GitHubと連携してください（初回のみ）",
    reason: hasGitHubProvisioningSource
      ? "GitHub Appは接続済みです。Agent Studio本体とは別のprivate RepositoryをBuilderが自動作成します。"
      : "GitHub Appを一度連携すると、会社専用のprivate RepositoryはBuilderが自動作成します。Repository名などの入力は不要です。",
    fields: [],
    instructions: [hasGitHubProvisioningSource ? "接続済みGitHub Appを使用します" : "GitHub Appを会社のGitHub Organizationへ連携します", "会社専用Repository、default branch、生成先はBuilderが自動設定します"],
    isImplementationApproval: false,
    requiresRepositoryChange: hasGitHubProvisioningSource,
    primaryActionLabel: hasGitHubProvisioningSource ? "専用Repositoryを自動作成する" : "GitHubと連携する",
    implementation: null,
  };
  if (action.type === "repository_merge") return {
    title: "テスト済みの変更をIntegration Repositoryへ反映します",
    reason: "この承認後、PRを既定branchへmergeし、デプロイとRuntimeへのTool登録まで自動で追跡します。",
    fields: [],
    instructions: action.instructions,
    isImplementationApproval: false,
    requiresRepositoryChange: false,
    primaryActionLabel: "承認してToolを反映する",
    implementation: null,
  };
  const selectedCoreRepository = codeWorkspace
    && typeof condition.repository_url === "string"
    && /github\.com\/[^/]+\/agent-studio(?:\.git)?$/i.test(condition.repository_url);
  if (selectedCoreRepository) return {
    title: "企業専用Integration Repositoryを自動準備します",
    reason: "企業専用ToolはAgent Studio本体へ入れず、会社が所有するprivate Repositoryを自動作成して反映します。",
    fields: [],
    instructions: ["会社用のIntegration RepositoryをGitHub Appで接続します", "接続成功後、このAgentの保存先を自動で差し替えます"],
    isImplementationApproval: false,
    requiresRepositoryChange: true,
    primaryActionLabel: "専用Repositoryを自動作成する",
    implementation: null,
  };
  if (!codeWorkspace) return {
    title: action.title,
    reason: action.reason,
    fields: action.fields,
    instructions: action.instructions,
    isImplementationApproval: false,
    requiresRepositoryChange: false,
    primaryActionLabel: "回答して続ける",
    implementation: null,
  };

  const proposal = typeof condition.interface_notes === "string" && condition.interface_notes.trim()
    ? condition.interface_notes.trim()
    : inferProposal(projectRequest, "依頼文に明示された検索条件と取得項目だけを扱い、登録・更新はしない。");
  const topic = typeof condition.topic === "string" ? condition.topic.replace(/^code_workspace:/, "") : "";
  const name = implementationName(topic, projectRequest);
  const destination = implementationDestination(action.instructions);
  const normalizedInstructions = action.instructions.map((instruction) => {
    if (instruction.includes("default branch") || instruction.includes("基点branch")) return "保存先と作業branchは自動設定します";
    if (instruction.includes("専用branch") && instruction.includes("main")) return "mainへ直接変更せず、専用branchで作業します";
    if (instruction.includes("契約テスト") || instruction.includes("Secret検査")) return "テストとSecret検査に合格した変更だけを採用します";
    return instruction;
  });

  return {
    title: `${name}を作成します`,
    reason: "次の1つのToolを作ると、Agentが依頼された情報を取得できるようになります。",
    fields: action.fields.filter((field) => field.name !== "interface_notes"),
    instructions: normalizedInstructions,
    isImplementationApproval: true,
    requiresRepositoryChange: false,
    primaryActionLabel: `${name}を作成する`,
    implementation: {
      name,
      outcome: proposal,
      destination,
      changes: ["企業専用Runtimeから実行する連携コード", "Agentから呼び出すTool定義", "動作確認用の自動テスト"],
      safety: normalizedInstructions.filter((instruction) => /main|テスト|Secret|branch/i.test(instruction)),
    },
  };
}
