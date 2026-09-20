import type { AgentToolParam } from "openai/resources/beta/agents/agents";
import type { SessionCreateParams } from "../infrastructure/openai/agents-api.js";
import { OPENAI_HOSTED_TEMPLATES, RUNTIME_GATEWAY_SERVER_LABEL, type CompiledAgentConfig } from "./manifest-compiler.js";

export interface SessionBuildOptions {
  /** self_hosted で Runtime のツールを使うとき: Tool Gateway の MCP の URL と、このセッション専用のトークン */
  gateway?: { url: string; sessionToken: string };
  /** service MCP の接続先ごとの vault の参照（connection_id → vault_id / credential_id） */
  vaults: Map<string, { vaultId: string; credentialId: string | null }>;
  metadata: Record<string, string>;
}

/** コンパイル結果から OpenAI のセッション作成パラメータを組み立てる（初回の入力は含めない） */
export function buildSessionCreateParams(config: CompiledAgentConfig, opts: SessionBuildOptions): SessionCreateParams {
  const tools: AgentToolParam[] = [];
  const variables = config.variables ?? {};
  const variableInstructions = Object.keys(variables).length
    ? `\n\n## この環境の設定値\n${Object.entries(variables).map(([name, value]) => `- ${name}: ${value}`).join("\n")}`
    : "";

  for (const f of config.function_tools) {
    tools.push({ type: "function", name: f.name, description: f.description, parameters: f.parameters });
  }

  const vaultIds = new Set<string>();
  for (const s of config.service_mcp_tools) {
    const vault = s.connection_id ? opts.vaults.get(s.connection_id) : undefined;
    if (vault) vaultIds.add(vault.vaultId);
    tools.push({
      type: "mcp",
      server_label: s.server_label,
      connection_origin: "service",
      transport: { type: "http", server_url: s.server_url },
      ...(s.allowed_tools ? { allowed_tools: s.allowed_tools } : {}),
      ...(vault?.credentialId ? { credential_id: vault.credentialId } : {}),
    });
  }

  if (config.runtime_tools.length > 0) {
    if (!opts.gateway) throw new Error("Runtime のツールを使うには Tool Gateway の接続先が必要です");
    // 接続は Session Worker（顧客の VPC 内）から行う。トークンはこのセッションでしか使えない
    tools.push({
      type: "mcp",
      server_label: RUNTIME_GATEWAY_SERVER_LABEL,
      connection_origin: "environment",
      transport: {
        type: "http",
        server_url: opts.gateway.url,
        headers: { Authorization: `Bearer ${opts.gateway.sessionToken}` },
      },
      allowed_tools: config.runtime_tools,
      required: true,
    });
  }

  const env = config.environment;
  const environment: SessionCreateParams["environment"] =
    env.type === "self_hosted"
      ? { type: "self_hosted", workspace_directory: env.workspace_directory }
      : env.type === "openai_hosted"
        ? {
            type: "openai_hosted",
            network: {
              access: env.network.mode,
              ...(env.network.mode === "restricted" ? { allowed_domains: env.network.allowed_domains ?? [] } : {}),
            },
            ...OPENAI_HOSTED_TEMPLATES[env.template],
          }
        : { type: "none" };

  return {
    environment,
    agent: {
      model: config.model,
      instructions: `${config.instructions}${variableInstructions}`,
      ...(config.reasoning_effort ? { reasoning: { effort: config.reasoning_effort } } : {}),
      tools,
    },
    metadata: opts.metadata,
    ...(vaultIds.size > 0 ? { vault_ids: [...vaultIds] } : {}),
  };
}
