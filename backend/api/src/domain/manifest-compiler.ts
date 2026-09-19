import {
  WRITE_LIKE_RISKS,
  type AgentManifest,
  type NetworkPolicy,
  type OpenAiTemplate,
  type Policy,
  type ReasoningEffort,
  type RuntimeToolCatalogEntry,
  type ToolInputSchema,
  type ToolRisk,
  type ToolVersionSpec,
} from "@agent-studio/contracts";

/** Tool Gateway に接続する MCP の server_label */
export const RUNTIME_GATEWAY_SERVER_LABEL = "agent_studio_runtime";
export const SELF_HOSTED_WORKSPACE = "/workspace";

/** すべての Agent に付ける共通の指示（承認フローと秘密情報の扱い） */
export const AGENT_STUDIO_PREAMBLE = `## Agent Studio からの共通の指示
- ツールが「承認が必要です」と返した場合は、別の方法で同じ操作をしようとせず、承認待ちであることを報告して作業を止めてください。
- 「承認されました」と伝えられたら、承認待ちになっていた操作を同じ内容でもう一度実行してください。
- 「却下されました」「期限が切れました」と伝えられた操作は実行しないでください。
- 環境変数や設定ファイルにある認証情報・秘密の値を読み取ったり、出力したりしないでください。

## この業務の指示
`;

export interface ResolvedTool {
  tool_id: string;
  tool_version_id: string;
  name: string;
  version: number;
  spec: ToolVersionSpec;
}

export interface CompileProfile {
  id: string;
  key: string;
  type: "none" | "openai_hosted" | "self_hosted";
  template: OpenAiTemplate | null;
  network: NetworkPolicy | null;
  runtime: {
    id: string;
    status: string;
    gateway_url: string | null;
    tool_catalog: RuntimeToolCatalogEntry[];
  } | null;
}

export type CompiledEnvironment =
  | { type: "none" }
  | { type: "openai_hosted"; template: OpenAiTemplate; network: NetworkPolicy }
  | { type: "self_hosted"; runtime_id: string; workspace_directory: string };

export interface CompiledFunctionTool {
  name: string;
  description: string;
  parameters: ToolInputSchema;
  tool_version_id: string;
  risk: ToolRisk;
  spec: Extract<ToolVersionSpec, { execution_location: "studio_function" }>["studio_function"];
}

export interface CompiledServiceMcpTool {
  name: string;
  server_label: string;
  server_url: string;
  allowed_tools: string[] | null;
  connection_id: string | null;
  tool_version_id: string;
}

/** デプロイ時点のコンパイル結果（deployments.compiled_config）。シークレットは含めない（CMP-05） */
export interface CompiledAgentConfig {
  version: 1;
  model: string;
  reasoning_effort: ReasoningEffort | null;
  instructions: string;
  environment: CompiledEnvironment;
  function_tools: CompiledFunctionTool[];
  service_mcp_tools: CompiledServiceMcpTool[];
  /** Tool Gateway 経由で使う Runtime のツール */
  runtime_tools: string[];
  /** 組織 + Manifest + 暗黙のポリシーを連結したもの（評価は最も厳しい結果になる） */
  policies: Policy[];
  warnings: string[];
}

export type CompileResult = { ok: true; config: CompiledAgentConfig } | { ok: false; errors: string[]; warnings: string[] };

export function compileAgent(input: {
  manifest: AgentManifest;
  tools: ResolvedTool[];
  profile: CompileProfile;
  orgPolicies: Policy[];
  defaultModel: string;
}): CompileResult {
  const { manifest, tools, profile } = input;
  const errors: string[] = [];
  const warnings: string[] = [];

  const model = manifest.model.name ?? input.defaultModel;
  if (!model) errors.push("モデルが指定されていません。Manifest の model.name を指定してください");

  const functionTools: CompiledFunctionTool[] = [];
  const serviceMcp: CompiledServiceMcpTool[] = [];
  const runtimeTools: string[] = [];
  const riskByTool = new Map<string, ToolRisk>();
  let readsUntrusted = false;

  for (const t of tools) {
    riskByTool.set(t.name, t.spec.risk);
    switch (t.spec.execution_location) {
      case "studio_function":
        functionTools.push({
          name: t.name,
          description: t.spec.description,
          parameters: t.spec.input_schema,
          tool_version_id: t.tool_version_id,
          risk: t.spec.risk,
          spec: t.spec.studio_function,
        });
        break;
      case "openai_service_mcp":
        serviceMcp.push({
          name: t.name,
          server_label: t.name,
          server_url: t.spec.service_mcp.server_url,
          allowed_tools: t.spec.service_mcp.allowed_tools ?? null,
          connection_id: t.spec.service_mcp.connection_id ?? null,
          tool_version_id: t.tool_version_id,
        });
        break;
      case "runtime_mcp": {
        if (profile.type !== "self_hosted") {
          errors.push(`ツール ${t.name} は社内システムのツールのため、企業の AWS の実行環境でしか使えません`);
          break;
        }
        const catalogEntry = profile.runtime?.tool_catalog.find((c) => c.name === t.name);
        if (!catalogEntry) {
          errors.push(`ツール ${t.name} は実行環境 ${profile.key} の Runtime にありません（Runtime 側の設定に追加してください）`);
          break;
        }
        if (t.spec.reads_untrusted_content || catalogEntry.reads_untrusted_content) readsUntrusted = true;
        // Runtime 側のリスク区分のほうが高ければそちらを使う
        riskByTool.set(t.name, higherRisk(t.spec.risk, catalogEntry.risk));
        runtimeTools.push(t.name);
        break;
      }
    }
  }

  let environment: CompiledEnvironment;
  if (profile.type === "self_hosted") {
    if (!profile.runtime) {
      errors.push("実行環境に Runtime が設定されていません");
      environment = { type: "none" };
    } else {
      if (profile.runtime.status === "revoked") errors.push("この実行環境の Runtime は無効にされています");
      else if (profile.runtime.status === "pending") errors.push("この実行環境の Runtime はまだ登録されていません");
      if (runtimeTools.length > 0 && !profile.runtime.gateway_url) {
        errors.push("Runtime から Tool Gateway の接続先がまだ報告されていません。Runtime の起動を確認してください");
      }
      environment = { type: "self_hosted", runtime_id: profile.runtime.id, workspace_directory: SELF_HOSTED_WORKSPACE };
    }
  } else if (profile.type === "openai_hosted") {
    environment = {
      type: "openai_hosted",
      template: profile.template ?? "general-python",
      network: profile.network ?? { mode: "disabled" },
    };
  } else {
    environment = { type: "none" };
  }

  // 暗黙のポリシー
  const implicit: Policy[] = [];
  const explicitApprovalTools = new Set(manifest.policies.filter((p) => p.type === "approval").map((p) => p.tool));
  for (const [name, risk] of riskByTool) {
    if (risk === "destructive" && !explicitApprovalTools.has(name)) {
      implicit.push({ type: "approval", tool: name, timeout_minutes: 1440, reason: `${name} は取り消せない操作のため承認が必要です` });
    }
  }
  if (readsUntrusted) {
    // POL-07: 外部の内容を読む Agent は、更新系の操作をすべて承認制にする（プロンプトインジェクション対策）
    for (const [name, risk] of riskByTool) {
      if (WRITE_LIKE_RISKS.includes(risk) && risk !== "destructive") {
        implicit.push({
          type: "approval",
          tool: name,
          timeout_minutes: 1440,
          reason: "外部の内容を読み込むエージェントのため、更新を伴う操作には承認が必要です",
        });
      }
    }
  }

  for (const p of manifest.policies) {
    if (p.tool !== "*" && serviceMcp.some((s) => s.name === p.tool)) {
      warnings.push(`ツール ${p.tool} は OpenAI から直接接続するため、ポリシーを Agent Studio で強制できません`);
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  return {
    ok: true,
    config: {
      version: 1,
      model,
      reasoning_effort: manifest.model.reasoning_effort ?? null,
      instructions: `${AGENT_STUDIO_PREAMBLE}${manifest.instructions}`,
      environment,
      function_tools: functionTools,
      service_mcp_tools: serviceMcp,
      runtime_tools: runtimeTools,
      policies: [...input.orgPolicies, ...manifest.policies, ...implicit],
      warnings,
    },
  };
}

const RISK_ORDER: ToolRisk[] = ["read", "write", "external_send", "financial", "destructive"];
function higherRisk(a: ToolRisk, b: ToolRisk): ToolRisk {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

/** OpenAI-hosted のテンプレート → 事前に入れるパッケージ（ENV-02） */
export const OPENAI_HOSTED_TEMPLATES: Record<
  OpenAiTemplate,
  { packages?: { python?: string[]; npm?: string[] }; setup_commands?: { command: string }[] }
> = {
  "general-python": {},
  "data-analysis": { packages: { python: ["pandas", "numpy", "matplotlib", "openpyxl"] } },
  "document-processing": { packages: { python: ["python-docx", "openpyxl", "pypdf", "markdown"] } },
  "browser-basic": {
    packages: { python: ["playwright"] },
    setup_commands: [{ command: "python -m playwright install --with-deps chromium" }],
  },
};
