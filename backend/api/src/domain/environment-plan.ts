import type { CapabilityResolutionDto, EnvironmentPlanDto, OpenAiTemplate } from "@agent-studio/contracts";

export type EnvironmentPlanTool = {
  name: string;
  execution_location: string;
  /** Connector の base_url。外部送信先の表示に使う */
  connector_base_url: string | null;
};

export type EnvironmentPlanInput = {
  request: string;
  resolution: CapabilityResolutionDto;
  tools: EnvironmentPlanTool[];
  /** browser_flow の Change Set がある */
  browserFlow: boolean;
  /** 企業専用 Adapter package を Runtime へ配布済み・配布予定 */
  adapterPackages: boolean;
};

const TEMPLATE_LABELS: Record<OpenAiTemplate, string> = {
  "general-python": "標準",
  "browser-basic": "ブラウザ",
  "data-analysis": "データ集計",
  "document-processing": "文書処理",
};

const DATA_ANALYSIS_PATTERN = /(?:集計|統計|分析|グラフ|csv|excel|エクセル|スプレッドシート|表計算|売上|数値)/i;
const DOCUMENT_PATTERN = /(?:pdf|請求書|契約書|見積|領収書|書類|文書|ocr|スキャン|画像|写真)/i;

/**
 * 利用者に「実行環境」を選ばせず、必要な能力から実行場所を決める。
 * - Runtime Tool・ブラウザ・企業専用 Adapter を使う → 顧客 Runtime（Self-hosted、管理者承認が必要）
 * - それ以外 → OpenAI 環境。HTTP 連携は Tool Gateway 側で実行するため、コンテナ自体の外部通信は禁止のまま
 */
export function planEnvironment(input: EnvironmentPlanInput): EnvironmentPlanDto {
  const selected = new Set(input.resolution.selected_tools);
  const tools = input.tools.filter((tool) => selected.has(tool.name));
  const runtimeTools = tools.filter((tool) => tool.execution_location === "runtime_mcp");
  const egress = [...new Set(tools.flatMap((tool) => {
    if (!tool.connector_base_url) return [];
    try {
      return [new URL(tool.connector_base_url).hostname];
    } catch {
      return [];
    }
  }))].sort();
  const modelOnly = input.resolution.requirements.every((requirement) => requirement.fulfillment?.mode === "model") && tools.length === 0;

  if (runtimeTools.length > 0 || input.browserFlow || input.adapterPackages) {
    const reasons = [
      ...(input.browserFlow ? ["ブラウザ操作を隔離環境で行うため"] : []),
      ...(runtimeTools.length > 0 || input.adapterPackages ? ["社内システムへ安全に接続するため"] : []),
    ];
    return {
      kind: "self_hosted",
      template: null,
      network: null,
      profile_key: "builder-self-hosted",
      profile_name: "貴社専用の実行環境",
      execution_location: "runtime",
      egress,
      reason: `${reasons.join("、")}、貴社AWS内の専用環境で実行します。AWS管理者の承認が必要です。`,
      requires_human: "aws_admin_action",
    };
  }

  const text = `${input.request}\n${input.resolution.requirements.map((requirement) => requirement.requirement).join("\n")}`;
  const template: OpenAiTemplate = DOCUMENT_PATTERN.test(text) ? "document-processing" : DATA_ANALYSIS_PATTERN.test(text) ? "data-analysis" : "general-python";
  return {
    kind: "openai_hosted",
    template,
    network: { mode: "disabled" },
    profile_key: `builder-openai-${template}`,
    profile_name: `Agent Studio標準環境（${TEMPLATE_LABELS[template]}）`,
    execution_location: modelOnly ? "model" : "studio",
    egress,
    reason: modelOnly
      ? "外部システムへ接続せず、安全なクラウド環境でAIモデルだけで処理します。"
      : egress.length
        ? `安全なクラウド環境で処理し、外部通信は ${egress.join("、")} だけに限定します。`
        : "安全なクラウド環境で処理し、外部への通信は行いません。",
    requires_human: false,
  };
}
