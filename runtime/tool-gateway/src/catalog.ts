import {
  inputSchemaSchema,
  type Policy,
  type RuntimeHttpTool,
  type RuntimeToolCatalogEntry,
  type RuntimeToolConfig,
  type RuntimeToolDelivery,
  type RuntimeUpstreamMcp,
  type SessionGrant,
  type ToolInputSchema,
  type ToolRisk,
} from "@agent-studio/contracts";
import type { Logger } from "./logger.js";
import { errorMessage } from "./logger.js";
import { upstreamExposedName } from "./tool-config.js";
import type { UpstreamToolInfo } from "./upstream.js";

export type ToolTarget =
  | { kind: "http"; tool: RuntimeHttpTool }
  | { kind: "upstream"; upstream: RuntimeUpstreamMcp; toolName: string };

export interface CatalogTool {
  /** Agent に見せる名前 */
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  risk: ToolRisk;
  readsUntrustedContent: boolean;
  delivery?: RuntimeToolDelivery;
  /** ツール・配下のサーバーに書かれた Runtime 側のポリシー */
  policies: Policy[];
  target: ToolTarget;
}

const FALLBACK_SCHEMA: ToolInputSchema = { type: "object", properties: {} };

/** 配下の MCP サーバーのツール一覧を、許可リストで絞り、名前を付け替える */
export function buildUpstreamTools(upstream: RuntimeUpstreamMcp, infos: UpstreamToolInfo[]): { tools: CatalogTool[]; missing: string[] } {
  const byName = new Map(infos.map((t) => [t.name, t]));
  const tools: CatalogTool[] = [];
  const missing: string[] = [];
  for (const allowed of upstream.tools) {
    const info = byName.get(allowed.name);
    if (!info) {
      missing.push(allowed.name);
      continue;
    }
    const schema = inputSchemaSchema.safeParse(info.inputSchema);
    tools.push({
      name: upstreamExposedName(allowed),
      description: (info.description?.trim() || `${upstream.name} の ${allowed.name}`).slice(0, 1000),
      inputSchema: schema.success ? schema.data : FALLBACK_SCHEMA,
      risk: allowed.risk,
      readsUntrustedContent: allowed.reads_untrusted_content,
      ...(allowed.delivery ? { delivery: allowed.delivery } : {}),
      policies: upstream.policies,
      target: { kind: "upstream", upstream, toolName: allowed.name },
    });
  }
  return { tools, missing };
}

/** Run ごとの endpoint は起動前に問い合わせられないため、Runtime 設定で固定した schema からカタログを作る。 */
export function buildDynamicUpstreamTools(upstream: RuntimeUpstreamMcp): CatalogTool[] {
  return upstream.tools.map((tool) => ({
    name: upstreamExposedName(tool),
    description: tool.description ?? `${upstream.name} の ${tool.name}`,
    inputSchema: tool.input_schema ?? FALLBACK_SCHEMA,
    risk: tool.risk,
    readsUntrustedContent: tool.reads_untrusted_content,
    ...(tool.delivery ? { delivery: tool.delivery } : {}),
    policies: upstream.policies,
    target: { kind: "upstream" as const, upstream, toolName: tool.name },
  }));
}

/**
 * Tool Gateway が提供できるツールの一覧（CRT-11: Runtime 側の設定にあるものだけ）。
 * HTTP ツールは設定から、配下の MCP サーバーのツールは起動時と定期的に取り直す。
 */
export class ToolCatalog {
  private readonly httpTools = new Map<string, CatalogTool>();
  private readonly upstreamTools = new Map<string, CatalogTool[]>();

  constructor(
    private readonly config: RuntimeToolConfig,
    private readonly lister: (upstream: RuntimeUpstreamMcp) => Promise<UpstreamToolInfo[]>,
    private readonly logger: Logger,
  ) {
    for (const tool of config.tools) {
      this.httpTools.set(tool.name, {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input_schema,
        risk: tool.risk,
        readsUntrustedContent: tool.reads_untrusted_content,
        ...(tool.delivery ? { delivery: tool.delivery } : {}),
        policies: tool.policies,
        target: { kind: "http", tool },
      });
    }
  }

  /** 全体に適用する Runtime 側のポリシー */
  get globalPolicies(): Policy[] {
    return this.config.policies;
  }

  async refreshUpstreams(): Promise<void> {
    await Promise.all(
      this.config.upstream_mcp.map(async (upstream) => {
        try {
          if (upstream.dynamic_session_endpoint === "browser") {
            const tools = buildDynamicUpstreamTools(upstream);
            this.upstreamTools.set(upstream.name, tools);
            this.logger.debug({ upstream: upstream.name, tools: tools.length }, "動的 endpoint のツール設定を読み込みました");
            return;
          }
          const { tools, missing } = buildUpstreamTools(upstream, await this.lister(upstream));
          this.upstreamTools.set(upstream.name, tools);
          if (missing.length > 0) {
            this.logger.warn({ upstream: upstream.name, missing }, "許可リストにあるツールが配下の MCP サーバーにありません");
          }
          this.logger.debug({ upstream: upstream.name, tools: tools.length }, "配下の MCP サーバーのツールを取得しました");
        } catch (err) {
          // 取れなかったときは前回の一覧を使い続ける
          this.logger.warn({ upstream: upstream.name, err: errorMessage(err) }, "配下の MCP サーバーのツール一覧を取得できませんでした");
        }
      }),
    );
  }

  get(name: string): CatalogTool | undefined {
    const http = this.httpTools.get(name);
    if (http) return http;
    for (const tools of this.upstreamTools.values()) {
      const hit = tools.find((t) => t.name === name);
      if (hit) return hit;
    }
    return undefined;
  }

  all(): CatalogTool[] {
    return [...this.httpTools.values(), ...[...this.upstreamTools.values()].flat()];
  }

  /** Controller のハートビートで Agent Studio に報告する形 */
  entries(): RuntimeToolCatalogEntry[] {
    return this.all().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
      risk: t.risk,
      reads_untrusted_content: t.readsUntrustedContent,
      ...(t.delivery ? { delivery: t.delivery } : {}),
    }));
  }

  /** セッションに見せるツール = 許可されたツール ∩ このカタログ */
  visibleFor(grant: SessionGrant): CatalogTool[] {
    const out: CatalogTool[] = [];
    const seen = new Set<string>();
    for (const name of grant.allowed_tools) {
      if (seen.has(name)) continue;
      seen.add(name);
      const tool = this.get(name);
      if (!tool) continue;
      if (tool.target.kind === "upstream" && tool.target.upstream.dynamic_session_endpoint === "browser") {
        if (!grant.browser) continue;
        if (grant.browser.mode === "authenticated_restricted" && tool.target.toolName === "browser_exec_js") continue;
      }
      out.push(tool);
    }
    return out;
  }
}
