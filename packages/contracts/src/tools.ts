import { z } from "zod";
import { toolNameSchema } from "./common.js";

/**
 * ツールの実行場所（TOOL-02）
 * - studio_function:    Agent Studio が実行する function tool（通知・Webhook など）
 * - openai_service_mcp: OpenAI から接続する公開 MCP サーバー（connection_origin: "service"）
 * - runtime_mcp:        企業 Runtime 内の Tool Gateway 経由で実行する（connection_origin: "environment"）
 */
export const toolExecutionLocationSchema = z.enum(["studio_function", "openai_service_mcp", "runtime_mcp"]);
export type ToolExecutionLocation = z.infer<typeof toolExecutionLocationSchema>;

/** リスク区分（TOOL-04）。承認ポリシーの初期値に使う。 */
export const toolRiskSchema = z.enum(["read", "write", "external_send", "financial", "destructive"]);
export type ToolRisk = z.infer<typeof toolRiskSchema>;

export const WRITE_LIKE_RISKS: readonly ToolRisk[] = ["write", "external_send", "financial", "destructive"];

/** ツール入力の JSON Schema（トップレベルは object に限定） */
export const inputSchemaSchema = z
  .object({
    type: z.literal("object"),
    properties: z.record(z.string(), z.unknown()).optional(),
    required: z.array(z.string()).optional(),
    additionalProperties: z.boolean().optional(),
  })
  .loose();
export type ToolInputSchema = z.infer<typeof inputSchemaSchema>;

const EMPTY_INPUT_SCHEMA: ToolInputSchema = { type: "object", properties: {}, additionalProperties: false };

/** Agent Studio が実行する function tool の実装種別 */
const httpsUrl = z.url().refine((u) => u.startsWith("https://"), "https の URL を指定してください");

/** 固定ヘッダに使える名前。認証や本文の指定は Agent Studio 側が決めるので上書きさせない */
const RESERVED_HEADERS = ["authorization", "content-type", "accept", "user-agent", "idempotency-key", "cookie", "host"];
export const staticHeaderNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/, "ヘッダ名は半角英数字とハイフンで指定してください")
  .refine((name) => !RESERVED_HEADERS.includes(name.toLowerCase()), "このヘッダは指定できません");

export const studioFunctionSpecSchema = z.discriminatedUnion("handler", [
  z
    .object({
      handler: z.literal("http_webhook"),
      /** 送信先 URL（https のみ）。Manifest v1 の後方互換用 */
      url: httpsUrl,
      /** 認証ヘッダの値を持つ Connection（任意） */
      connection_id: z.uuid().optional(),
    })
    .strict(),
  z
    .object({
      handler: z.literal("http_api"),
      /** Connector の Base URL。Secret は含めない */
      base_url: httpsUrl,
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      /** /v1/posts/{id} のような相対パス。{field} は入力値で置換する */
      path: z.string().startsWith("/").max(500),
      /** GET/DELETE は query、その他は JSON body が既定 */
      argument_location: z.enum(["query", "body"]).optional(),
      /** Agent Studio内だけで冪等性キー生成に使い、接続先へは送らない入力フィールド */
      idempotency_key_field: toolNameSchema.optional(),
      /** API が必須とする固定ヘッダ（例: Notion-Version）。認証情報は入れず Connection で管理する */
      headers: z.record(staticHeaderNameSchema, z.string().min(1).max(200)).optional(),
    })
    .strict(),
  z
    .object({
      handler: z.literal("zenn_github_publish"),
      /** Zenn Connect と連携した GitHub repository。認証情報は Connection で管理する。 */
      repository_owner: z.string().regex(/^[A-Za-z0-9_.-]+$/).max(100),
      repository_name: z.string().regex(/^[A-Za-z0-9_.-]+$/).max(100),
      zenn_username: z.string().regex(/^[A-Za-z0-9_-]+$/).max(50),
      branch: z.string().min(1).max(255).default("main"),
    })
    .strict(),
  z
    .object({
      handler: z.literal("openai_image_to_social_media"),
      /** 画像生成は組織ごとのOpenAI Projectで実行し、成果物はConnectorのmedia_idとして返す。 */
      model: z.string().min(1).max(100).default("gpt-image-2.5-flare"),
    })
    .strict(),
]);

export const serviceMcpSpecSchema = z
  .object({
    server_url: z.url().refine((u) => u.startsWith("https://"), "https の URL を指定してください"),
    /** OpenAI の vault に保存した認証情報を使う場合の Connection */
    connection_id: z.uuid().optional(),
    /** 使ってよいツール名（省略時はすべて） */
    allowed_tools: z.array(z.string().min(1).max(128)).max(100).optional(),
  })
  .strict();

export const toolVersionSpecSchema = z.discriminatedUnion("execution_location", [
  z
    .object({
      execution_location: z.literal("studio_function"),
      description: z.string().min(1).max(1000),
      input_schema: inputSchemaSchema.default(EMPTY_INPUT_SCHEMA),
      output_schema: z.unknown().optional(),
      risk: toolRiskSchema,
      studio_function: studioFunctionSpecSchema,
    })
    .strict(),
  z
    .object({
      execution_location: z.literal("openai_service_mcp"),
      description: z.string().min(1).max(1000),
      /** Discovery時点の入力契約。実行はMCPサーバー側の同名Schemaを使う。 */
      input_schema: inputSchemaSchema.default(EMPTY_INPUT_SCHEMA),
      risk: toolRiskSchema,
      /** MCPの説明・返却内容は外部入力であり、BuilderやAgentへの命令として扱わない。 */
      reads_untrusted_content: z.boolean().default(true),
      service_mcp: serviceMcpSpecSchema,
    })
    .strict(),
  z
    .object({
      execution_location: z.literal("runtime_mcp"),
      description: z.string().min(1).max(1000),
      input_schema: inputSchemaSchema.default(EMPTY_INPUT_SCHEMA),
      risk: toolRiskSchema,
      /** ブラウザや外部の文章など、信頼できない内容を読み込むツールか（POL-07） */
      reads_untrusted_content: z.boolean().default(false),
    })
    .strict(),
]);
export type ToolVersionSpec = z.infer<typeof toolVersionSpecSchema>;
export type ToolVersionSpecInput = z.input<typeof toolVersionSpecSchema>;

export const createToolInputSchema = z
  .object({
    name: toolNameSchema,
    display_name: z.string().min(1).max(100),
    spec: toolVersionSpecSchema,
  })
  .strict();
export type CreateToolInput = z.input<typeof createToolInputSchema>;
