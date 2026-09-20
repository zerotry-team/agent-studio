import { createHash } from "node:crypto";
import type { CompiledFunctionTool } from "../domain/manifest-compiler.js";
import type { TenantDb } from "../infrastructure/db/tenant-db.js";
import { assertPublicUrl, isPrivateAddress } from "../infrastructure/http/public-url.js";
import type { SecretStore } from "../infrastructure/secrets/secret-store.js";

const TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 20_000;

const ZENN_TITLE_MAX = 70;
const ZENN_BODY_MAX = 100_000;

interface ZennArticleInput {
  title: string;
  body: string;
  emoji: string;
  topics: string[];
  type: "tech" | "idea";
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}を入力してください`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${label}は${max}文字以内にしてください`);
  return result;
}

/** Zenn CLI と同じ frontmatter を、YAML injection が起きない JSON scalar で生成する。 */
export function buildZennArticle(args: Record<string, unknown>): ZennArticleInput & { markdown: string } {
  const title = requiredText(args.title, "タイトル", ZENN_TITLE_MAX);
  const body = requiredText(args.body, "本文", ZENN_BODY_MAX);
  const emoji = typeof args.emoji === "string" && args.emoji.trim() ? args.emoji.trim() : "🤖";
  const type = args.type === "idea" ? "idea" : "tech";
  const topics = Array.isArray(args.topics)
    ? [...new Set(args.topics.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))].slice(0, 5)
    : [];
  const markdown = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `emoji: ${JSON.stringify(emoji)}`,
    `type: ${JSON.stringify(type)}`,
    `topics: ${JSON.stringify(topics)}`,
    "published: true",
    "---",
    "",
    body,
    "",
  ].join("\n");
  return { title, body, emoji, topics, type, markdown };
}

/** 同じ Run の再試行は同じ記事を更新し、二重投稿を作らない。 */
export function zennArticleSlug(runId: string): string {
  return createHash("sha256").update(`agent-studio-zenn:${runId}`).digest("hex").slice(0, 16);
}

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
      case "zenn_github_publish":
        if (!context) throw new Error("実行コンテキストがありません");
        return this.zennGithubPublish(organizationId, tool, args, context);
    }
  }

  private async linkedSecret(
    organizationId: string,
    tool: CompiledFunctionTool,
    context: { agentId: string; stage: "staging" | "production"; runId: string },
  ): Promise<{ connectionId: string; value: string }> {
    if (!tool.connector_id) throw new Error("連携サービスの設定が不完全です");
    const link = await this.db.org(organizationId, (tx) =>
      tx.agent_connection_links.findFirst({
        where: {
          organization_id: organizationId,
          agent_id: context.agentId,
          connector_id: tool.connector_id!,
          stage: context.stage,
        },
        include: { connection: true },
      }),
    );
    if (!link) throw new Error(`${context.stage === "staging" ? "Preview" : "Production"}のConnectionが許可されていません`);
    if (!(link.allowed_capabilities as string[]).includes(tool.name)) throw new Error(`${tool.name} はこのAgentに許可されていません`);
    if (link.connection.connector_id !== tool.connector_id || link.connection.status !== "connected" || !link.connection.secret_locator) {
      throw new Error("Connectionが利用できません");
    }
    const value = await this.secrets.get(link.connection.secret_locator);
    if (!value) throw new Error("Connectionの認証情報を読み込めませんでした");
    return { connectionId: link.connection.id, value };
  }

  private async zennGithubPublish(
    organizationId: string,
    tool: CompiledFunctionTool,
    args: Record<string, unknown>,
    context: { agentId: string; stage: "staging" | "production"; runId: string },
  ): Promise<string> {
    if (tool.spec.handler !== "zenn_github_publish") throw new Error("Zenn連携の設定が不完全です");
    const article = buildZennArticle(args);
    const slug = zennArticleSlug(context.runId);
    const path = `articles/${slug}.md`;
    const repository = `${tool.spec.repository_owner}/${tool.spec.repository_name}`;
    const apiUrl = await assertPublicUrl(`https://api.github.com/repos/${repository}/contents/${path}`);
    const secret = await this.linkedSecret(organizationId, tool, context);
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${secret.value.trim()}`,
      "content-type": "application/json",
      "user-agent": "agent-studio-zenn-publisher",
      "x-github-api-version": "2022-11-28",
    };

    let sha: string | undefined;
    const existing = await fetch(`${apiUrl.toString()}?ref=${encodeURIComponent(tool.spec.branch)}`, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (existing.ok) {
      const value = (await existing.json()) as { sha?: unknown };
      if (typeof value.sha === "string") sha = value.sha;
    } else if (existing.status !== 404) {
      throw new Error(`GitHubで記事の既存状態を確認できませんでした（HTTP ${existing.status}）`);
    }

    const response = await fetch(apiUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: `${sha ? "update" : "publish"}: ${article.title}`,
        content: Buffer.from(article.markdown, "utf8").toString("base64"),
        branch: tool.spec.branch,
        ...(sha ? { sha } : {}),
      }),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const responseText = (await response.text()).slice(0, MAX_OUTPUT);
    await this.db.org(organizationId, (tx) =>
      tx.audit_logs.create({
        data: {
          organization_id: organizationId,
          actor_type: "system",
          actor_id: context.runId,
          action: "credential.use",
          target_type: "connection",
          target_id: secret.connectionId,
          result: response.ok ? "success" : "failure",
          detail: { connector_id: tool.connector_id, tool: tool.name, stage: context.stage, status: response.status, article_slug: slug },
        },
      }),
    );
    if (!response.ok) throw new Error(`GitHubへの記事反映に失敗しました（HTTP ${response.status}）: ${responseText.slice(0, 500)}`);
    return JSON.stringify({
      status: sha ? "updated" : "published",
      slug,
      article_url: `https://zenn.dev/${tool.spec.zenn_username}/articles/${slug}`,
      repository,
      path,
    });
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
