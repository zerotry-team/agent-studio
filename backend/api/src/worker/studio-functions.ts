import { createHash } from "node:crypto";
import { filterResponseFields, validateJsonSchema } from "@agent-studio/contracts";
import type { Env } from "../env.js";
import type { CompiledFunctionTool } from "../domain/manifest-compiler.js";
import { inspectArtifact } from "../domain/artifact-security.js";
import type { TenantDb } from "../infrastructure/db/tenant-db.js";
import { assertPublicUrl, isPrivateAddress } from "../infrastructure/http/public-url.js";
import type { SecretStore } from "../infrastructure/secrets/secret-store.js";
import { artifactPrefix, type ObjectStore } from "../infrastructure/storage/object-store.js";

const TIMEOUT_MS = 15_000;
const IMAGE_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 20_000;
const MAX_SOCIAL_MEDIA_BYTES = 3 * 1024 * 1024;

const ZENN_TITLE_MAX = 70;
const ZENN_BODY_MAX = 100_000;

async function readResponseLimited(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body.cancel().catch(() => undefined);
    return { text: "", truncated: true };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated: false };
    if (size + value.byteLength > limit) {
      if (limit > size) chunks.push(value.subarray(0, limit - size));
      await reader.cancel().catch(() => undefined);
      return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated: true };
    }
    chunks.push(value);
    size += value.byteLength;
  }
}

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

const PUBLIC_FACTORING_POST = /^匿名審査ID=ANON-[A-Z0-9]{8,32}; 結果=(approve_candidate|hold); 理由=[A-Z_]+(?:,[A-Z_]+)*; 検証用投稿$/;

/** Social Routerへ渡す前の最終データ境界。可候補/保留の固定形式以外は承認済みでも拒否する。 */
export function validateAnonymousXPost(args: Record<string, unknown>): void {
  if (typeof args.account_id !== "string" || !args.account_id.trim()) throw new Error("X投稿先アカウントがありません");
  if (typeof args.text !== "string" || !PUBLIC_FACTORING_POST.test(args.text)) {
    throw new Error("X投稿本文が匿名化済みファクタリング公開payload契約に一致しません");
  }
  if (/\d{6,}|https?:\/\/|@/.test(args.text)) throw new Error("X投稿本文に公開禁止情報の可能性があります");
  const allowed = new Set(["account_id", "text", "logical_post_id"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) throw new Error("X投稿payloadに許可されていない項目があります");
}

/** 内部ネットワークへのリクエスト（SSRF）を防ぐ。Control Plane の VPC やメタデータに届かないようにする */
export { assertPublicUrl, isPrivateAddress };

/** Agent Studio が実行する function tool（studio_function） */
export class StudioFunctionExecutor {
  constructor(
    private readonly db: TenantDb,
    private readonly secrets: SecretStore,
    private readonly env?: Pick<Env, "NODE_ENV" | "OPENAI_API_KEY" | "ARTIFACTS_BUCKET">,
    private readonly objects?: ObjectStore,
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
        // ファクタリング用の固定公開payloadだけに追加制約を適用する。
        // 汎用のpublish_postまで同じ形式に限定すると、通常のSNS投稿が実行不能になる。
        if (tool.name === "publish_post" && typeof args.text === "string" && args.text.startsWith("匿名審査ID=")) {
          validateAnonymousXPost(args);
        }
        return this.httpApi(organizationId, tool, args, context);
      case "zenn_github_publish":
        if (!context) throw new Error("実行コンテキストがありません");
        return this.zennGithubPublish(organizationId, tool, args, context);
      case "openai_image_to_social_media":
        if (!context) throw new Error("実行コンテキストがありません");
        return this.openAiImageToSocialMedia(organizationId, tool, args, context);
      case "openai_image_artifact":
        if (!context) throw new Error("実行コンテキストがありません");
        return this.openAiImageArtifact(organizationId, tool, args, context);
    }
  }

  private async generateOpenAiImage(
    organizationId: string,
    model: string,
    promptValue: unknown,
  ): Promise<{ bytes: Buffer; revisedPrompt?: string; usage?: unknown }> {
    const prompt = requiredText(promptValue, "画像の説明", 8_000);
    const settings = await this.db.org(organizationId, (tx) =>
      tx.organization_openai_settings.findUnique({ where: { organization_id: organizationId } }),
    );
    let openAiKey = settings?.app_key_secret_arn ? await this.secrets.get(settings.app_key_secret_arn) : null;
    if (!openAiKey && this.env?.NODE_ENV !== "production") openAiKey = this.env?.OPENAI_API_KEY ?? null;
    if (!openAiKey) throw new Error("OpenAIの接続が未設定です。設定から接続してください");
    const headers: Record<string, string> = {
      authorization: `Bearer ${openAiKey}`,
      "content-type": "application/json",
      "user-agent": "agent-studio-image-tool",
    };
    if (settings?.openai_project_id) headers["openai-project"] = settings.openai_project_id;
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers,
      body: JSON.stringify({ model, prompt, size: "1024x1024", quality: "medium", output_format: "png" }),
      redirect: "error",
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => null)) as {
      data?: Array<{ b64_json?: unknown; revised_prompt?: unknown }>;
      usage?: unknown;
      error?: { message?: unknown };
    } | null;
    const result = payload?.data?.[0];
    const base64 = typeof result?.b64_json === "string" ? result.b64_json : null;
    if (!response.ok || !base64) {
      const detail = typeof payload?.error?.message === "string" ? payload.error.message.slice(0, 500) : "画像データがありません";
      throw new Error(`OpenAIで画像を生成できませんでした（HTTP ${response.status}）: ${detail}`);
    }
    const bytes = Buffer.from(base64, "base64");
    if (bytes.byteLength > MAX_SOCIAL_MEDIA_BYTES) throw new Error("生成画像がArtifact上限を超えました");
    return {
      bytes,
      ...(typeof result?.revised_prompt === "string" ? { revisedPrompt: result.revised_prompt } : {}),
      ...(payload?.usage ? { usage: payload.usage } : {}),
    };
  }

  private async openAiImageArtifact(
    organizationId: string,
    tool: CompiledFunctionTool,
    args: Record<string, unknown>,
    context: { agentId: string; stage: "staging" | "production"; runId: string },
  ): Promise<string> {
    if (tool.spec.handler !== "openai_image_artifact") throw new Error("画像生成設定が不完全です");
    if (!this.env?.ARTIFACTS_BUCKET || !this.objects) throw new Error("画像Artifactの保存先が設定されていません");
    const model = tool.spec.model;
    const generated = await this.generateOpenAiImage(organizationId, model, args.prompt);
    const sha256 = createHash("sha256").update(generated.bytes).digest("hex");
    const path = `generated-image-${sha256.slice(0, 16)}.png`;
    const inspected = inspectArtifact(path, generated.bytes);
    const objectKey = `${artifactPrefix(organizationId, context.runId)}${path}`;
    if (inspected.scanStatus !== "passed") throw new Error("生成画像がArtifact安全検査を通過しませんでした");
    await this.objects.put(this.env.ARTIFACTS_BUCKET, objectKey, generated.bytes, "image/png");
    await this.db.org(organizationId, async (tx) => {
      await tx.run_artifacts.upsert({
        where: { organization_id_run_id_path: { organization_id: organizationId, run_id: context.runId, path } },
        create: { organization_id: organizationId, run_id: context.runId, path, object_key: objectKey, mime_type: "image/png", size_bytes: generated.bytes.byteLength, sha256, scan_status: "passed", scan_engine: inspected.scanEngine, source: "openai_image_generation", retained_until: new Date(Date.now() + 30 * 24 * 60 * 60_000) },
        update: { object_key: objectKey, size_bytes: generated.bytes.byteLength, sha256, scan_status: "passed", scan_engine: inspected.scanEngine, retained_until: new Date(Date.now() + 30 * 24 * 60 * 60_000) },
      });
      await tx.audit_logs.create({ data: {
        organization_id: organizationId,
        actor_type: "system",
        actor_id: context.runId,
        action: "model.image.generate",
        target_type: "run",
        target_id: context.runId,
        result: "success",
        detail: { tool: tool.name, model, artifact_path: path, mime_type: "image/png", bytes: generated.bytes.byteLength, sha256, safety_status: "provider_accepted", usage: generated.usage ?? null },
      } });
    });
    return JSON.stringify({ artifact_path: path, mime_type: "image/png", bytes: generated.bytes.byteLength, sha256, model, safety_status: "provider_accepted", ...(generated.revisedPrompt ? { revised_prompt: generated.revisedPrompt } : {}), ...(generated.usage ? { usage: generated.usage } : {}) });
  }

  private async linkedSecret(
    organizationId: string,
    tool: CompiledFunctionTool,
    context: { agentId: string; stage: "staging" | "production"; runId: string },
  ): Promise<{ connectionId: string; value: string; headerName: string }> {
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
    return { connectionId: link.connection.id, value, headerName: link.connection.header_name ?? "Authorization" };
  }

  /**
   * 組織のOpenAI Projectで画像を生成し、同じAgentに許可されたSocial Routerへ直接保存する。
   * base64はDB・ログ・モデル出力へ残さず、後続のpublish_postへ渡せるmedia_idだけを返す。
   */
  private async openAiImageToSocialMedia(
    organizationId: string,
    tool: CompiledFunctionTool,
    args: Record<string, unknown>,
    context: { agentId: string; stage: "staging" | "production"; runId: string },
  ): Promise<string> {
    if (tool.spec.handler !== "openai_image_to_social_media" || !tool.connector_id) {
      throw new Error("画像生成連携の設定が不完全です");
    }
    const spec = tool.spec;
    const generated = await this.generateOpenAiImage(organizationId, spec.model, args.prompt);
    const bytes = generated.bytes;
    const base64 = bytes.toString("base64");

    const [connector, secret] = await Promise.all([
      this.db.org(organizationId, (tx) => tx.connectors.findFirst({ where: { organization_id: organizationId, id: tool.connector_id! } })),
      this.linkedSecret(organizationId, tool, context),
    ]);
    if (!connector?.base_url) throw new Error("Social Router連携サービスが見つかりません");
    const mediaUrl = await assertPublicUrl(`${connector.base_url.replace(/\/$/, "")}/v1/media`);
    const authHeader = secret.headerName.toLowerCase();
    const mediaHeaders: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "agent-studio-image-tool",
      [authHeader]: authHeader === "authorization" && !/^\S+\s/.test(secret.value) ? `Bearer ${secret.value}` : secret.value,
      "idempotency-key": buildIdempotencyKey(context.runId, tool.name, "generated-image"),
    };
    const mediaResponse = await fetch(mediaUrl, {
      method: "POST",
      headers: mediaHeaders,
      body: JSON.stringify({ content_base64: base64, mime_type: "image/png", filename: `${context.runId}.png` }),
      redirect: "error",
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
    const mediaText = (await mediaResponse.text()).slice(0, MAX_OUTPUT);
    const mediaPayload: { data?: { id?: unknown }; id?: unknown } = (() => {
      try {
        return JSON.parse(mediaText) as { data?: { id?: unknown }; id?: unknown };
      } catch {
        return {};
      }
    })();
    const mediaId = typeof mediaPayload?.data?.id === "string"
      ? mediaPayload.data.id
      : typeof mediaPayload?.id === "string" ? mediaPayload.id : null;
    await this.db.org(organizationId, (tx) =>
      tx.audit_logs.create({
        data: {
          organization_id: organizationId,
          actor_type: "system",
          actor_id: context.runId,
          action: "credential.use",
          target_type: "connection",
          target_id: secret.connectionId,
          result: mediaResponse.ok && mediaId ? "success" : "failure",
          detail: {
            connector_id: tool.connector_id,
            tool: tool.name,
            stage: context.stage,
            status: mediaResponse.status,
            provider: "openai_image_generation",
            model: spec.model,
            bytes: bytes.byteLength,
          },
        },
      }),
    );
    if (!mediaResponse.ok || !mediaId) {
      throw new Error(`生成画像をSocial Routerへ保存できませんでした（HTTP ${mediaResponse.status}）: ${mediaText.slice(0, 500)}`);
    }
    return JSON.stringify({
      media_id: mediaId,
      mime_type: "image/png",
      bytes: bytes.byteLength,
      ...(generated.revisedPrompt ? { revised_prompt: generated.revisedPrompt } : {}),
    });
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
    const access = await this.db.org(organizationId, async (tx) => ({
      connector: await tx.connectors.findFirst({ where: { organization_id: organizationId, id: tool.connector_id! } }),
      link: await tx.agent_connection_links.findFirst({
        where: {
          organization_id: organizationId,
          agent_id: context.agentId,
          connector_id: tool.connector_id!,
          stage: context.stage,
        },
        include: { connection: true },
      }),
    }));
    if (!access.connector) throw new Error("連携サービスが見つかりません");
    const connector = access.connector;
    const link = access.link;
    if (connector.auth_type !== "none") {
      if (!link) throw new Error(`${context.stage === "staging" ? "Preview" : "Production"}のConnectionが許可されていません`);
      if (!(link.allowed_capabilities as string[]).includes(tool.name)) throw new Error(`${tool.name} はこのAgentに許可されていません`);
      if (link.connection.connector_id !== tool.connector_id || link.connection.status !== "connected") {
        throw new Error("Connectionが利用できません");
      }
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
    if (connector.auth_type !== "none") {
      if (!link?.connection.secret_locator) throw new Error("Connectionの認証情報が未設定です");
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
    const boundary = tool.spec.response_boundary;
    const read = await readResponseLimited(response, boundary?.max_bytes ?? MAX_OUTPUT);
    const text = read.text;
    await this.db.org(organizationId, async (tx) => {
      await tx.audit_logs.create({
        data: {
          organization_id: organizationId,
          actor_type: "system",
          actor_id: context.runId,
          action: link ? "credential.use" : "connector.call",
          target_type: link ? "connection" : "connector",
          target_id: link?.connection.id ?? connector.id,
          result: response.ok ? "success" : "failure",
          detail: { connector_id: tool.connector_id, tool: tool.name, stage: context.stage, status: response.status },
        },
      });
    });
    if (!response.ok) throw new Error(`連携サービスがエラーを返しました（HTTP ${response.status}）: ${text.slice(0, 500)}`);
    if (read.truncated) throw new Error("連携サービスの応答が許可されたサイズ上限を超えています");
    if (!text) return JSON.stringify({ accepted: response.status === 202, status: response.status });
    if (boundary || tool.output_schema !== undefined) {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new Error("連携サービスの応答がJSONではありません");
      }
      if (tool.output_schema !== undefined) {
        try {
          validateJsonSchema(value, tool.output_schema);
        } catch (error) {
          throw new Error(`連携サービスのresponse schemaが変わっています: ${(error as Error).message}`);
        }
      }
      return JSON.stringify(boundary ? filterResponseFields(value, boundary) : value);
    }
    return text;
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
