import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { CompiledFunctionTool } from "../domain/manifest-compiler.js";
import type { TenantDb } from "../infrastructure/db/tenant-db.js";
import type { SecretStore } from "../infrastructure/secrets/secret-store.js";

const TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 20_000;

/** 内部ネットワークへのリクエスト（SSRF）を防ぐ。Control Plane の VPC やメタデータに届かないようにする */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("https の URL だけ使えます");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error("内部ネットワークのアドレスには送信できません");
  }
  return url;
}

/** Agent Studio が実行する function tool（studio_function） */
export class StudioFunctionExecutor {
  constructor(
    private readonly db: TenantDb,
    private readonly secrets: SecretStore,
  ) {}

  async execute(organizationId: string, tool: CompiledFunctionTool, args: Record<string, unknown>): Promise<string> {
    switch (tool.spec.handler) {
      case "http_webhook":
        return this.httpWebhook(organizationId, tool, args);
    }
  }

  private async httpWebhook(organizationId: string, tool: CompiledFunctionTool, args: Record<string, unknown>): Promise<string> {
    const url = await assertPublicUrl(tool.spec.url);
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "agent-studio" };

    if (tool.spec.connection_id) {
      const connection = await this.db.org(organizationId, (tx) =>
        tx.connections.findFirst({ where: { id: tool.spec.connection_id!, organization_id: organizationId } }),
      );
      if (!connection?.secret_locator) throw new Error("接続先の認証情報が設定されていません");
      const value = await this.secrets.get(connection.secret_locator);
      if (!value) throw new Error("接続先の認証情報を読み込めませんでした");
      headers[(connection.header_name ?? "Authorization").toLowerCase()] = value;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(args),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = (await res.text()).slice(0, MAX_OUTPUT);
    if (!res.ok) throw new Error(`送信先がエラーを返しました（HTTP ${res.status}）: ${text.slice(0, 500)}`);
    return text || `送信しました（HTTP ${res.status}）`;
  }
}
