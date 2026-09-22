import { z } from "zod";
import { slugSchema, toolNameSchema } from "./common.js";
import { policySchema } from "./policy.js";
import { inputSchemaSchema, toolRiskSchema } from "./tools.js";
import { responseBoundarySchema } from "./response-boundary.js";

/**
 * Runtime 側（顧客 AWS）で管理するツール設定（CRT-11）。
 * 実行方法（接続先 URL・認証情報）はここにしか書かないため、
 * Agent Studio が侵害されても、この設定にないツールは実行できない。
 *
 * infra/company/<tenant>/config.yaml の runtime.tools から SSM パラメータに書き込まれ、
 * Tool Gateway が起動時に読み込む。
 */

/** 認証情報は Secrets Manager の論理名で参照する（値は書かない） */
const secretNameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "シークレット名の形式が正しくありません");

export const httpToolAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.literal("bearer"), secret: secretNameSchema }).strict(),
  z
    .object({
      type: z.literal("header"),
      header_name: z.string().regex(/^[A-Za-z0-9-]+$/),
      secret: secretNameSchema,
    })
    .strict(),
  /** シークレットの値は {"username":"...","password":"..."} の JSON */
  z.object({ type: z.literal("basic"), secret: secretNameSchema }).strict(),
]);
export type HttpToolAuth = z.infer<typeof httpToolAuthSchema>;

/**
 * Runtimeへdigest固定で配布されたAdapterの証跡。
 * Tool Gatewayはこの値を実行設定からheartbeatへそのまま伝え、Control Planeが
 * 受理済みpackageと完全一致する場合だけTool Catalogへ登録する。
 */
export const runtimeToolDeliverySchema = z
  .object({
    connector_key: slugSchema,
    contract_hash: z.string().regex(/^[0-9a-f]{64}$/),
    image_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    source_commit: z.string().regex(/^[0-9a-f]{40,64}$/),
    package_signature: z.string().min(20).max(1000),
  })
  .strict();
export type RuntimeToolDelivery = z.infer<typeof runtimeToolDeliverySchema>;

export const runtimeHttpToolSchema = z
  .object({
    name: toolNameSchema,
    description: z.string().min(1).max(1000),
    risk: toolRiskSchema,
    reads_untrusted_content: z.boolean().default(false),
    input_schema: inputSchemaSchema,
    delivery: runtimeToolDeliverySchema.optional(),
    http: z
      .object({
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        /** 例: https://api.internal/products/{product_id}。{} の中は引数名（URL エンコードして埋め込む） */
        url: z.string().min(1).max(2000),
        auth: httpToolAuthSchema.default({ type: "none" }),
        headers: z.record(z.string(), z.string()).optional(),
        timeout_ms: z.number().int().min(100).max(120000).default(15000),
        /** 企業Runtime内でRaw responseを縮小し、許可fieldだけをモデルへ返す。 */
        response_boundary: responseBoundarySchema.optional(),
        /** OpenAPIから固定した成功応答schema。drift時はモデルへ返さず失敗させる。 */
        output_schema: z.unknown().optional(),
      })
      .strict(),
    /** Runtime 側で追加するポリシー（顧客が管理） */
    policies: z.array(policySchema).default([]),
  })
  .strict();
export type RuntimeHttpTool = z.infer<typeof runtimeHttpToolSchema>;

export const runtimeUpstreamMcpSchema = z
  .object({
    name: slugSchema,
    /** VPC 内の MCP サーバー（Streamable HTTP） */
    url: z.url(),
    /** 公開してよいツール（ここにないツールは Agent に見せない） */
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1).max(128),
            /** Agent に見せる名前（省略時は name）。MCP のツール名と被らないようにするため */
            expose_as: toolNameSchema.optional(),
            risk: toolRiskSchema,
            reads_untrusted_content: z.boolean().default(false),
            /** Run ごとの endpoint では起動前に一覧取得できないため、設定側で schema を固定する。 */
            description: z.string().min(1).max(1000).optional(),
            input_schema: inputSchemaSchema.optional(),
            delivery: runtimeToolDeliverySchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    /** Session Grant の browser.endpoint へ接続する動的 upstream。 */
    dynamic_session_endpoint: z.literal("browser").optional(),
    policies: z.array(policySchema).default([]),
  })
  .strict();
export type RuntimeUpstreamMcp = z.infer<typeof runtimeUpstreamMcpSchema>;

/**
 * 企業専用Adapter（CIが署名した社内システム用Tool）をTool Gatewayで起動するときに渡す値。
 * env は平文の設定（社内APIのURLなど）、secrets は環境変数名 → Runtime側Secret名。
 * AdapterにはここにあるものしかRuntimeの値を渡さない。
 */
export const adapterRuntimeSchema = z
  .object({
    env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.string().max(2000)).default({}),
    secrets: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), secretNameSchema).default({}),
  })
  .strict();
export type AdapterRuntime = z.infer<typeof adapterRuntimeSchema>;

export const runtimeToolConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    tools: z.array(runtimeHttpToolSchema).default([]),
    upstream_mcp: z.array(runtimeUpstreamMcpSchema).default([]),
    /** すべてのツールに適用する Runtime 側のポリシー */
    policies: z.array(policySchema).default([]),
    adapter_runtime: adapterRuntimeSchema.default({ env: {}, secrets: {} }),
  })
  .strict();
export type RuntimeToolConfig = z.infer<typeof runtimeToolConfigSchema>;
export type RuntimeToolConfigInput = z.input<typeof runtimeToolConfigSchema>;
