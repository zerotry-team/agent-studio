import type { CapabilityRequirementDto, CapabilityResolutionDto } from "@agent-studio/contracts";
import type { GeneratedAgent, GeneratorToolInfo } from "../infrastructure/llm/manifest-generator.js";

export interface ResolverTool extends GeneratorToolInfo {
  connector_auth_type: string | null;
}

const AUTO_SELECT_CONFIDENCE = 0.75;
const BROWSER_CAPABILITIES = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_screenshot",
  "browser_wait_for",
  "browser_tabs",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_select_option",
  "browser_hover",
  "browser_drag",
  "browser_exec_js",
]);

/**
 * LLMが分解した業務要件を登録済み能力へ安全側に解決する。
 * 低信頼・複数Connector・存在しない候補は自動選択しない。
 */
export function resolveCapabilities(
  generated: GeneratedAgent,
  tools: ResolverTool[],
  installedConnectorIds: Set<string>,
): CapabilityResolutionDto {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const generatedRequirements = generated.requirements ?? [];
  const rawRequirements =
    generatedRequirements.length > 0
      ? generatedRequirements
      : (generated.tools ?? []).map((name) => ({
          description: byName.get(name)?.description ?? name,
          candidate_tools: [name],
          confidence: 1,
          reason: "生成結果で明示された能力です",
          kind: "tool" as const,
        }));

  const requirements: CapabilityRequirementDto[] = rawRequirements.map((requirement) => {
    const candidates = [...new Set(requirement.candidate_tools)].map((name) => byName.get(name)).filter((v): v is ResolverTool => Boolean(v));
    if (requirement.kind === "model" && candidates.length === 0) {
      return {
        requirement: requirement.description,
        state: "resolved",
        connector_id: null,
        connector_name: null,
        tool_names: [],
        confidence: requirement.confidence,
        reason: requirement.reason || "Agent自身が実行します",
      };
    }
    if (candidates.length === 0) {
      return {
        requirement: requirement.description,
        state: "missing",
        connector_id: null,
        connector_name: null,
        tool_names: [],
        confidence: requirement.confidence,
        reason: requirement.reason || "一致する連携サービスがありません",
      };
    }
    const connectorIds = new Set(candidates.map((candidate) => candidate.connector_id ?? `tool:${candidate.name}`));
    if (requirement.confidence < AUTO_SELECT_CONFIDENCE || connectorIds.size > 1) {
      return {
        requirement: requirement.description,
        state: "ambiguous",
        connector_id: null,
        connector_name: null,
        tool_names: [],
        confidence: requirement.confidence,
        reason: requirement.confidence < AUTO_SELECT_CONFIDENCE ? "候補の確信度が低いため確認が必要です" : "複数の連携サービス候補があります",
      };
    }
    const first = candidates[0]!;
    // Browserはユーザーに内部Actionを個別選択させず、Connectorを1能力としてBuild時に展開する。
    const selectedCandidates =
      BROWSER_CAPABILITIES.has(first.name) && first.connector_id
        ? tools.filter((tool) => tool.connector_id === first.connector_id && BROWSER_CAPABILITIES.has(tool.name))
        : candidates;
    const needsConnection =
      Boolean(first.connector_id) && first.connector_auth_type !== null && first.connector_auth_type !== "none" && !installedConnectorIds.has(first.connector_id!);
    return {
      requirement: requirement.description,
      state: needsConnection ? "needs_connection" : "resolved",
      connector_id: first.connector_id,
      connector_name: first.connector_name,
      tool_names: selectedCandidates.map((candidate) => candidate.name),
      confidence: requirement.confidence,
      reason: needsConnection ? `${first.connector_name ?? "連携サービス"}への接続が必要です` : requirement.reason,
    };
  });

  const selectedTools = requirements.flatMap((requirement) =>
    requirement.state === "resolved" || requirement.state === "needs_connection" ? requirement.tool_names : [],
  );
  const missingVariables = [...new Set(generated.missing_variables ?? [])];
  return {
    requirements,
    selected_tools: [...new Set(selectedTools)],
    missing_variables: missingVariables,
    ready: requirements.every((requirement) => requirement.state === "resolved") && missingVariables.length === 0,
  };
}
