import type {
  CapabilityFulfillmentDto,
  CapabilityRequirementDto,
  CapabilityResolutionDto,
} from "@agent-studio/contracts";

const SHARED_PROVIDER_PATTERN = /(?:kintone|salesforce|slack|notion|github|jira|confluence|google(?:\s+workspace| drive| sheets| calendar)?|microsoft(?:\s+365| teams| outlook)?|supabase|stripe|shopify|zendesk|hubspot|freee|moneyforward|マネーフォワード|スマレジ)/i;
const ORGANIZATION_PRIVATE_PATTERN = /(?:自社|社内|社用|社内専用|独自|private|internal|intranet|オンプレ|閉域|vpn|vpc|社内サーバー|ファイルサーバー|自社(?:db|データベース)|社内(?:db|データベース)|基幹システム)/i;
const EXTERNAL_ACTION_PATTERN = /(?:(?:sns|x|twitter|slack|メール|外部サービス|外部システム|crm|saas).*(?:投稿|送信|登録|更新|削除|予約|購入|決済)|(?:投稿|送信|登録|更新|削除|予約|購入|決済).*(?:sns|x|twitter|slack|メール|外部サービス|外部システム|crm|saas))/i;

/**
 * Capabilityの実装先を決める決定的な境界。
 * 汎用SaaS名は、依頼文に「自社の」があっても共有Connectorを優先する。
 * 顧客データやSecretを共有実装へ取り込まず、認証情報はConnectionへ分離する。
 */
export function classifyCapabilityFulfillment(
  projectRequest: string,
  requirement: CapabilityRequirementDto,
): CapabilityFulfillmentDto {
  if (requirement.state === "resolved" && (
    requirement.tool_names.length === 0
    || requirement.tool_names.every((name) => name === "web_search")
  )) {
    return {
      mode: "model",
      owner: "model",
      execution_location: "model",
      reason: "外部システムへ接続せず、モデル自身で実行できます",
      availability_target_minutes: null,
    };
  }
  if (requirement.state === "resolved") {
    const runtimeReuse = requirement.fulfillment?.execution_location === "runtime";
    return {
      mode: "reuse",
      owner: runtimeReuse ? "organization" : "agent_studio",
      execution_location: runtimeReuse || requirement.connector_name === "Runtime Tool Catalog" ? "runtime" : "studio",
      reason: runtimeReuse ? "企業専用Runtimeへ登録済みのToolを再利用します" : "利用可能なToolを再利用します",
      availability_target_minutes: null,
    };
  }
  if (requirement.state === "needs_connection") {
    return {
      mode: "configure",
      owner: "organization",
      execution_location: "studio",
      reason: "Toolは存在するため、認証または接続設定だけを行います",
      availability_target_minutes: null,
    };
  }

  const requirementText = `${requirement.requirement}\n${requirement.reason}`;
  const requestText = `${projectRequest}\n${requirementText}`;
  // GitHubが「実装先Repository」として依頼文に出ても、社内DB能力まで共有Toolへ誤分類しない。
  // Capability自身がkintone等を明示する場合だけ、汎用SaaSを優先する。
  if (!SHARED_PROVIDER_PATTERN.test(requirementText) && ORGANIZATION_PRIVATE_PATTERN.test(requestText)) {
    return {
      mode: "organization_private_adapter",
      owner: "organization",
      execution_location: "runtime",
      reason: "社内ネットワークまたは自社データへ接続するため、企業専用RuntimeへToolを実装します",
      availability_target_minutes: null,
    };
  }
  if (SHARED_PROVIDER_PATTERN.test(requirementText) || EXTERNAL_ACTION_PATTERN.test(requestText)) {
    return {
      mode: "shared_provider_adapter",
      owner: "agent_studio",
      execution_location: "studio",
      reason: "外部サービスの読み書きが必要なため、Agent Studioの共通Toolとして追加します",
      availability_target_minutes: 15,
    };
  }
  return {
    mode: "model",
    owner: "model",
    execution_location: "model",
    reason: "OCR・画像理解・要約・抽出・分類など、外部システムへ接続しない処理はOpenAIモデルで実行します",
    availability_target_minutes: null,
  };
}

export function annotateCapabilityFulfillment(
  projectRequest: string,
  resolution: CapabilityResolutionDto,
): CapabilityResolutionDto {
  const requirements = resolution.requirements.map((requirement) => {
    const fulfillment = classifyCapabilityFulfillment(projectRequest, requirement);
    if (fulfillment.mode !== "model") return { ...requirement, fulfillment };
    return {
      ...requirement,
      state: "resolved" as const,
      connector_id: null,
      connector_name: requirement.tool_names.every((name) => name === "web_search") && requirement.tool_names.length
        ? "OpenAI標準機能"
        : null,
      tool_names: requirement.tool_names.every((name) => name === "web_search")
        ? requirement.tool_names
        : [],
      reason: fulfillment.reason,
      variables: [],
      fulfillment,
    };
  });
  return {
    ...resolution,
    requirements,
    selected_tools: resolution.selected_tools.filter((name) =>
      requirements.some((requirement) => requirement.tool_names.includes(name)),
    ),
    ready: requirements.every((requirement) => requirement.state === "resolved"),
  };
}
