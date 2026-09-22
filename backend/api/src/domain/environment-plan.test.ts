import { describe, expect, it } from "vitest";
import type { CapabilityRequirementDto, CapabilityResolutionDto } from "@agent-studio/contracts";
import { planEnvironment } from "./environment-plan.js";

const requirement = (text: string, tools: string[], mode: "model" | "reuse" = tools.length ? "reuse" : "model"): CapabilityRequirementDto => ({
  requirement: text,
  state: "resolved",
  connector_id: null,
  connector_name: null,
  tool_names: tools,
  confidence: 1,
  reason: "",
  variables: [],
  fulfillment: { mode, owner: mode === "model" ? "model" : "agent_studio", execution_location: mode === "model" ? "model" : "studio", reason: "", availability_target_minutes: null },
});

const resolution = (requirements: CapabilityRequirementDto[]): CapabilityResolutionDto => ({
  requirements,
  selected_tools: requirements.flatMap((item) => item.tool_names),
  missing_variables: [],
  ready: true,
});

describe("planEnvironment", () => {
  it("モデルだけで完結する依頼はOpenAI環境・外部通信なし", () => {
    const plan = planEnvironment({ request: "問い合わせ文を分類して", resolution: resolution([requirement("分類する", [])]), tools: [], browserFlow: false, adapterPackages: false });
    expect(plan).toMatchObject({ kind: "openai_hosted", template: "general-python", execution_location: "model", egress: [], requires_human: false });
  });

  it("HTTP連携は外部送信先を限定したOpenAI環境にし、請求書の依頼は文書処理テンプレートを選ぶ", () => {
    const plan = planEnvironment({
      request: "請求書を読み取ってSlackに通知したい",
      resolution: resolution([requirement("Slackへ通知する", ["slack_post_message"])]),
      tools: [{ name: "slack_post_message", execution_location: "studio_function", connector_base_url: "https://slack.com/api" }],
      browserFlow: false,
      adapterPackages: false,
    });
    expect(plan).toMatchObject({ kind: "openai_hosted", template: "document-processing", execution_location: "studio", egress: ["slack.com"], profile_key: "builder-openai-document-processing" });
    expect(plan.reason).toContain("slack.com");
  });

  it("Runtime Toolやブラウザ操作は顧客Runtimeを要求し、AWS管理者の承認を必要とする", () => {
    const plan = planEnvironment({
      request: "社内DBを検索",
      resolution: resolution([requirement("社内DBを検索する", ["lookup_contract"])]),
      tools: [{ name: "lookup_contract", execution_location: "runtime_mcp", connector_base_url: null }],
      browserFlow: false,
      adapterPackages: false,
    });
    expect(plan).toMatchObject({ kind: "self_hosted", execution_location: "runtime", requires_human: "aws_admin_action" });
    expect(planEnvironment({ request: "サイトを調べる", resolution: resolution([]), tools: [], browserFlow: true, adapterPackages: false }).kind).toBe("self_hosted");
  });
});
