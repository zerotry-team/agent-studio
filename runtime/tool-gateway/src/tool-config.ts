import { readFile } from "node:fs/promises";
import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { runtimeToolConfigSchema, toolNameSchema, type RuntimeToolConfig } from "@agent-studio/contracts";
import YAML from "yaml";

export class ToolConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolConfigError";
  }
}

/** URL テンプレートの {param}。引数名の規則は Policy の field と同じ */
export const URL_PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function upstreamExposedName(tool: { name: string; expose_as?: string }): string {
  return tool.expose_as ?? tool.name;
}

/**
 * 設定の意味的な検証（スキーマでは表せないもの）。
 * - URL は http / https で、接続先（スキーム・ホスト・ポート）に {param} を含めない（Agent に接続先を選ばせない）
 * - Agent に見せるツール名が重複しない
 */
function validateSemantics(config: RuntimeToolConfig): string[] {
  const issues: string[] = [];
  const names = new Map<string, string>();
  const claim = (name: string, where: string) => {
    const prev = names.get(name);
    if (prev) issues.push(`ツール名 ${name} が重複しています（${prev} と ${where}）`);
    else names.set(name, where);
  };

  for (const tool of config.tools) {
    claim(tool.name, `tools.${tool.name}`);
    const template = tool.http.url;
    const leftover = template.replace(URL_PLACEHOLDER_RE, "");
    if (/[{}]/.test(leftover)) issues.push(`tools.${tool.name}: URL の {} の書き方が正しくありません`);
    const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(template)?.[0] ?? "";
    if (origin.includes("{")) {
      issues.push(`tools.${tool.name}: 接続先のホスト部分に {引数} は使えません`);
      continue;
    }
    let url: URL;
    try {
      url = new URL(template.replace(URL_PLACEHOLDER_RE, "x"));
    } catch {
      issues.push(`tools.${tool.name}: URL が正しくありません`);
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      issues.push(`tools.${tool.name}: URL は http か https にしてください`);
      continue;
    }
  }

  for (const upstream of config.upstream_mcp) {
    if (!/^https?:\/\//.test(upstream.url)) issues.push(`upstream_mcp.${upstream.name}: URL は http か https にしてください`);
    for (const t of upstream.tools) {
      const exposed = upstreamExposedName(t);
      if (!toolNameSchema.safeParse(exposed).success) {
        issues.push(
          `upstream_mcp.${upstream.name}.tools.${t.name}: Agent に見せる名前が規則（半角英小文字・数字・_）に合いません。expose_as を指定してください`,
        );
        continue;
      }
      claim(exposed, `upstream_mcp.${upstream.name}.${t.name}`);
    }
  }
  const upstreamNames = config.upstream_mcp.map((u) => u.name);
  if (new Set(upstreamNames).size !== upstreamNames.length) issues.push("upstream_mcp の name が重複しています");
  return issues;
}

/** JSON または YAML の文字列を読み、検証する */
export function parseToolConfig(text: string, source: string): RuntimeToolConfig {
  let raw: unknown;
  try {
    // YAML は JSON の上位互換なので、どちらでも読める
    raw = YAML.parse(text);
  } catch (err) {
    throw new ToolConfigError(`ツール設定（${source}）を読めません: ${(err as Error).message}`);
  }
  const parsed = runtimeToolConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ToolConfigError(`ツール設定（${source}）が正しくありません:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
  }
  const issues = validateSemantics(parsed.data);
  if (issues.length > 0) {
    throw new ToolConfigError(`ツール設定（${source}）が正しくありません:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
  }
  return parsed.data;
}

export async function loadToolConfig(opts: {
  parameterName?: string;
  path?: string;
  ssm?: Pick<SSMClient, "send">;
}): Promise<RuntimeToolConfig> {
  if (opts.parameterName) {
    if (!opts.ssm) throw new ToolConfigError("SSM クライアントがありません");
    const out = await opts.ssm.send(new GetParameterCommand({ Name: opts.parameterName, WithDecryption: true }));
    const value = out.Parameter?.Value;
    if (!value) throw new ToolConfigError(`SSM パラメータ ${opts.parameterName} に値がありません`);
    return parseToolConfig(value, `SSM ${opts.parameterName}`);
  }
  if (opts.path) {
    return parseToolConfig(await readFile(opts.path, "utf8"), opts.path);
  }
  throw new ToolConfigError("ツール設定の読み込み先がありません");
}
