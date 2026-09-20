import { createHash } from "node:crypto";
import type { CompiledFunctionTool } from "../domain/manifest-compiler.js";
import type { TenantDb } from "../infrastructure/db/tenant-db.js";
import { assertPublicUrl, isPrivateAddress } from "../infrastructure/http/public-url.js";
import type { SecretStore } from "../infrastructure/secrets/secret-store.js";

const TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 20_000;

export function prepareHttpArguments(
  method: string,
  args: Record<string, unknown>,
  configuredIdempotencyField?: string,
): { requestArgs: Record<string, unknown>; logicalId: string } {
  const requestArgs = { ...args };
  if (method !== "POST") return { requestArgs, logicalId: "request" };
  // 既存Connectorとの後方互換: logical_post_idは初期MVPで暗黙の内部フィールドだった。
  const field = configuredIdempotencyField ?? (Object.hasOwn(requestArgs, "logical_post_id") ? "logical_post_id" : undefined);
  const logicalId = field ? String(requestArgs[field] ?? "request") : "request";
  if (field) delete requestArgs[field];
  return { requestArgs, logicalId };
}

export function buildIdempotencyKey(runId: string, toolName: string, logicalId: string): string {
  return createHash("sha256").update(`${runId}:${toolName}:${logicalId}`).digest("hex");
}

/** 内部ネットワークへのリクエスト（SSRF）を防ぐ。Control Plane の VPC やメタデータに届かないようにする */
export { assertPublicUrl, isPrivateAddress };

/** Agent Studio が実行する function tool（studio_function） */
export class StudioFunctionExecutor {
  constructor(
    private readonly db: TenantDb,
    private readonly secrets: SecretStore,
  ) {}

  async execute(
    organizationId: string,
    tool: CompiledFunctionTool,
    args: Record<string, unknown>,
    context?: { agentId: string; stage: "staging" | "production"; runId: string },
  ): Promise<string> {
    switch (tool.spec.handler) {
      case "http_webhook":
        return this.httpWebhook(organizationId, tool, args);
      case "http_api":
        if (!context) throw new Error("実行コンテキストがありません");
        return this.httpApi(organizationId, tool, args, context);
    }
  }

  private async httpApi(
    organizationId: string,
    tool: CompiledFunctionTool,
    args: Record<string, unknown>,
    context: { agentId: string; stage: "staging" | "production"; runId: string },
  ): Promise<string> {
    if (tool.spec.handler !== "http_api" || !tool.connector_id) throw new Error("連携サービスの設定が不完全です");
    const link = await this.db.org(organizationId, (tx) =>
      tx.agent_connection_links.findFirst({
        where: {
          organization_id: organizationId,
          agent_id: context.agentId,
          connector_id: tool.connector_id!,
          stage: context.stage,
        },
        include: { connection: true, connector: true },
      }),
    );
    if (!link) throw new Error(`${context.stage === "staging" ? "Preview" : "Production"}のConnectionが許可されていません`);
    if (!(link.allowed_capabilities as string[]).includes(tool.name)) throw new Error(`${tool.name} はこのAgentに許可されていません`);
    if (link.connection.connector_id !== tool.connector_id || link.connection.status !== "connected") {
      throw new Error("Connectionが利用できません");
    }

    const prepared = prepareHttpArguments(tool.spec.method, args, tool.spec.idempotency_key_field);
    const remaining = prepared.requestArgs;
    const path = tool.spec.path.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key: string) => {
      const value = remaining[key];
      if (value === undefined || value === null || value === "") throw new Error(`パスに必要な ${key} がありません`);
      delete remaining[key];
      return encodeURIComponent(String(value));
    });
    const url = await assertPublicUrl(`${tool.spec.base_url}${path}`);
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "agent-studio" };
    // API が必須とする固定ヘッダ。認証・本文の指定より先に入れ、あとから上書きされるようにする
    for (const [name, value] of Object.entries(tool.spec.headers ?? {})) headers[name.toLowerCase()] = value;
    if (link.connector.auth_type !== "none") {
      if (!link.connection.secret_locator) throw new Error("Connectionの認証情報が未設定です");
      const secret = await this.secrets.get(link.connection.secret_locator);
      if (!secret) throw new Error("Connectionの認証情報を読み込めませんでした");
      const header = (link.connection.header_name ?? "Authorization").toLowerCase();
      headers[header] = header === "authorization" && !/^\S+\s/.test(secret) ? `Bearer ${secret}` : secret;
    }
    const argumentLocation = tool.spec.argument_location ?? (tool.spec.method === "GET" || tool.spec.method === "DELETE" ? "query" : "body");
    let body: string | undefined;
    if (argumentLocation === "query") {
      for (const [key, value] of Object.entries(remaining)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
    } else {
      headers["content-type"] = "application/json";
      body = JSON.stringify(remaining);
    }
    if (tool.spec.method === "POST") {
      headers["idempotency-key"] = buildIdempotencyKey(context.runId, tool.name, prepared.logicalId);
    }
    const response = await fetch(url, {
      method: tool.spec.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = (await response.text()).slice(0, MAX_OUTPUT);
    await this.db.org(organizationId, async (tx) => {
      await tx.audit_logs.create({
        data: {
          organization_id: organizationId,
          actor_type: "system",
          actor_id: context.runId,
          action: "credential.use",
          target_type: "connection",
          target_id: link.connection.id,
          result: response.ok ? "success" : "failure",
          detail: { connector_id: tool.connector_id, tool: tool.name, stage: context.stage, status: response.status },
        },
      });
    });
    if (!response.ok) throw new Error(`連携サービスがエラーを返しました（HTTP ${response.status}）: ${text.slice(0, 500)}`);
    return text || JSON.stringify({ accepted: response.status === 202, status: response.status });
  }

  private async httpWebhook(organizationId: string, tool: CompiledFunctionTool, args: Record<string, unknown>): Promise<string> {
    if (tool.spec.handler !== "http_webhook") throw new Error("Webhookの設定が不完全です");
    const spec = tool.spec;
    const url = await assertPublicUrl(spec.url);
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "agent-studio" };

    if (spec.connection_id) {
      const connection = await this.db.org(organizationId, (tx) =>
        tx.connections.findFirst({ where: { id: spec.connection_id!, organization_id: organizationId } }),
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
