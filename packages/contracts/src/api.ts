import { z } from "zod";
import { memberRoleSchema, slugSchema, stageSchema, toolNameSchema, type MemberRole, type Stage } from "./common.js";
import type { AgentManifest } from "./manifest.js";
import { policySchema, type Policy } from "./policy.js";
import type { ApprovalStatus } from "./runtime-protocol.js";
import type { ToolExecutionLocation, ToolInputSchema, ToolRisk, ToolVersionSpec } from "./tools.js";
import { staticHeaderNameSchema, toolVersionSpecSchema } from "./tools.js";
import { responseBoundarySchema } from "./response-boundary.js";

/**
 * フロントエンド ↔ Agent Studio API の契約。
 * - リクエストは *Schema（Zod）でサーバー側が検証する
 * - レスポンスは *Dto 型
 * - 操作対象の組織はヘッダ X-Organization-Id で選び、サーバーがメンバーシップを必ず再確認する（ORG-05）
 */
export const ORGANIZATION_HEADER = "x-organization-id";

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

// ---------------------------------------------------------------------------
// 組織・メンバー
// ---------------------------------------------------------------------------
export interface OrganizationDto {
  id: string;
  slug: string;
  name: string;
  status: "active" | "suspended";
  created_at: string;
}

export interface MembershipDto {
  organization: OrganizationDto;
  role: MemberRole;
  is_approver: boolean;
}

export interface MeDto {
  user: { id: string; email: string; display_name: string | null; is_platform_admin: boolean };
  memberships: MembershipDto[];
}

export const createOrganizationSchema = z
  .object({
    slug: slugSchema,
    name: z.string().trim().min(1).max(100),
    /** 最初の owner（メールアドレス） */
    owner_email: z.email(),
    /** OpenAI の Project ID（企業ごとに分ける。SEC-11） */
    openai_project_id: z.string().max(100).optional(),
  })
  .strict();
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export interface MemberDto {
  user_id: string;
  email: string;
  display_name: string | null;
  role: MemberRole;
  is_approver: boolean;
  created_at: string;
}

export const inviteMemberSchema = z
  .object({ email: z.email(), role: memberRoleSchema, is_approver: z.boolean().default(false) })
  .strict();
export type InviteMemberInput = z.input<typeof inviteMemberSchema>;

export const updateMemberSchema = z
  .object({ role: memberRoleSchema.optional(), is_approver: z.boolean().optional() })
  .strict();
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

// ---------------------------------------------------------------------------
// OpenAI 連携（組織ごとの Project とキー）
// ---------------------------------------------------------------------------
export const setOpenAiCredentialsSchema = z
  .object({
    openai_project_id: z.string().min(1).max(100),
    /** アプリキー（Agent Studio の Secrets Manager にだけ保存する） */
    app_api_key: z.string().min(20).max(500).optional(),
    /** 環境キー（Runtime に配布する。環境接続以外の権限を持たないこと） */
    environment_api_key: z.string().min(20).max(500).optional(),
    /** Orca Router キー。OpenAI のキーとは別の Secret として保存する */
    orcarouter_api_key: z.string().min(20).max(500).optional(),
    /** Builder の自然言語からの構成生成だけを Orca Router へ切り替える */
    orcarouter_text_enabled: z.boolean().optional(),
    /** Studio の画像生成 function だけを Orca Router へ切り替える */
    orcarouter_image_enabled: z.boolean().optional(),
    orcarouter_text_model: z.string().trim().min(1).max(200).optional(),
    orcarouter_image_model: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type SetOpenAiCredentialsInput = z.infer<typeof setOpenAiCredentialsSchema>;

export interface OpenAiSettingsDto {
  openai_project_id: string | null;
  has_app_api_key: boolean;
  has_environment_api_key: boolean;
  has_orcarouter_api_key: boolean;
  orcarouter_text_enabled: boolean;
  orcarouter_image_enabled: boolean;
  orcarouter_text_model: string;
  orcarouter_image_model: string;
  updated_at: string | null;
}

// ---------------------------------------------------------------------------
// ツール・接続先
// ---------------------------------------------------------------------------
export interface ToolVersionDto {
  id: string;
  version: number;
  spec: ToolVersionSpec;
  created_at: string;
}

export interface ToolDto {
  id: string;
  name: string;
  display_name: string;
  execution_location: ToolExecutionLocation;
  risk: ToolRisk;
  latest_version: number;
  connector_id: string | null;
  created_at: string;
  versions?: ToolVersionDto[];
}

export const connectorAdapterSchema = z.enum(["http_openapi", "internal_http_api", "mcp", "internal", "openai_builtin", "runtime"]);
export type ConnectorAdapter = z.infer<typeof connectorAdapterSchema>;
export const connectorAuthTypeSchema = z.enum(["none", "static_bearer", "runtime_secret"]);
export type ConnectorAuthType = z.infer<typeof connectorAuthTypeSchema>;

export const connectorOperationSchema = z
  .object({
    name: toolNameSchema,
    /** MCPサーバーが公開する元の操作名。Studio内の安全なTool名と異なる場合だけ指定する。 */
    provider_operation_name: z.string().trim().min(1).max(128).optional(),
    display_name: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(1000),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
    path: z.string().startsWith("/").max(500).optional(),
    /** この入力値はIdempotency-Key生成だけに使い、接続先のbody/queryへは送らない */
    idempotency_key_field: toolNameSchema.optional(),
    risk: z.enum(["read", "write", "external_send", "financial", "destructive"]),
    input_schema: z
      .object({
        type: z.literal("object"),
        properties: z.record(z.string(), z.unknown()).optional(),
        required: z.array(z.string()).optional(),
        additionalProperties: z.boolean().optional(),
      })
      .loose()
      .default({ type: "object", properties: {}, additionalProperties: false }),
    /** OpenAPIの成功レスポンスから抽出したJSON Schema。実行結果の契約検証に使う。 */
    output_schema: z.unknown().optional(),
    /** モデルへ返してよいfieldと応答上限。社内APIでは必ず設定する。 */
    response_boundary: responseBoundarySchema.optional(),
  })
  .strict();
export type ConnectorOperationInput = z.input<typeof connectorOperationSchema>;

export const createConnectorSchema = z
  .object({
    key: slugSchema,
    /** 内部用。Provider Catalog由来のConnectorであることを示す（OAuth設定などの解決キー）。 */
    provider_key: slugSchema.optional(),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(1000),
    adapter: connectorAdapterSchema.default("http_openapi"),
    base_url: z.url().refine((u) => u.startsWith("https://"), "https の URL を指定してください").optional(),
    auth_type: connectorAuthTypeSchema.default("none"),
    /** すべての操作に付ける固定ヘッダ（例: Notion-Version）。認証情報は入れない */
    default_headers: z
      .record(staticHeaderNameSchema, z.string().min(1).max(200))
      .refine((headers) => Object.keys(headers).length <= 10, "固定ヘッダは10個までです")
      .optional(),
    operations: z.array(connectorOperationSchema).min(1).max(100),
  })
  .strict()
  .refine((v) => new Set(v.operations.map((o) => o.name)).size === v.operations.length, {
    message: "操作名が重複しています",
    path: ["operations"],
  })
  .refine((v) => !["http_openapi", "internal_http_api"].includes(v.adapter) || Boolean(v.base_url), {
    message: "HTTP連携にはbase_urlが必要です",
    path: ["base_url"],
  })
  .refine((v) => !["http_openapi", "internal_http_api"].includes(v.adapter) || v.operations.every((o) => o.method && o.path), {
    message: "HTTP連携の各操作にはmethodとpathが必要です",
    path: ["operations"],
  })
  // MCP は接続先のサーバーが操作の一覧と入力の形式を持つため、method / path は使わない。
  .refine((v) => v.adapter !== "mcp" || Boolean(v.base_url), {
    message: "MCP連携にはサーバーのURLが必要です",
    path: ["base_url"],
  })
  .refine((v) => v.adapter !== "mcp" || v.operations.every((o) => !o.method && !o.path), {
    message: "MCP連携の操作にmethodとpathは指定できません",
    path: ["operations"],
  })
  .refine((v) => ["http_openapi", "internal_http_api"].includes(v.adapter) || !v.default_headers, {
    message: "固定ヘッダはHTTP連携でだけ指定できます",
    path: ["default_headers"],
  })
  .refine((v) => v.adapter !== "internal_http_api" || v.operations.every((operation) => operation.output_schema && operation.response_boundary), {
    message: "社内APIの各操作にはresponse schemaとfield allowlistが必要です",
    path: ["operations"],
  })
  .refine((v) => v.adapter !== "internal_http_api" || v.auth_type !== "none", {
    message: "社内APIには認証設定が必要です",
    path: ["auth_type"],
  });
export type CreateConnectorInput = z.input<typeof createConnectorSchema>;

/**
 * 連携サービスの編集。operations は編集後の全体を渡す（載っていない操作は削除）。
 * 振る舞いが変わる変更はツールの新しいバージョンになり、公開済みの Build には影響しない。
 */
export const updateConnectorSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(1000),
    base_url: z.url().refine((u) => u.startsWith("https://"), "https の URL を指定してください").optional(),
    default_headers: z
      .record(staticHeaderNameSchema, z.string().min(1).max(200))
      .refine((headers) => Object.keys(headers).length <= 10, "固定ヘッダは10個までです")
      .optional(),
    operations: z.array(connectorOperationSchema).min(1).max(100),
  })
  .strict()
  .refine((v) => new Set(v.operations.map((o) => o.name)).size === v.operations.length, {
    message: "操作名が重複しています",
    path: ["operations"],
  });
export type UpdateConnectorInput = z.input<typeof updateConnectorSchema>;

export const discoverMcpToolsSchema = z
  .object({
    server_url: z.url().refine((u) => u.startsWith("https://"), "https の URL を指定してください"),
  })
  .strict();
export type DiscoverMcpToolsInput = z.infer<typeof discoverMcpToolsSchema>;

/**
 * MCP サーバーが申告した操作。
 * 何をする操作かは接続先の実装で決まり、Agent Studio 側では変えられない。
 * annotations は任意項目なので、申告がない場合は null（不明）にする。
 */
export interface DiscoveredMcpToolDto {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
  /** true: 読み取り専用 / false: 書き換えあり / null: サーバーが申告していない */
  read_only: boolean | null;
  /** true: 取り消せない操作だと申告している */
  destructive: boolean;
}
export interface DiscoverMcpToolsResultDto {
  tools: DiscoveredMcpToolDto[];
}

export interface ConnectorDto {
  id: string;
  key: string;
  /** Provider Catalogのエントリ。カタログ外の手動登録はnull */
  provider_key: string | null;
  name: string;
  description: string;
  adapter: ConnectorAdapter;
  base_url: string | null;
  auth_type: ConnectorAuthType;
  created_at: string;
  tools: ToolDto[];
}

export const createToolVersionSchema = z.object({ spec: toolVersionSpecSchema }).strict();
export type CreateToolVersionInput = z.input<typeof createToolVersionSchema>;

export const connectionScopeSchema = z.enum(["studio", "openai_vault", "runtime"]);
export type ConnectionScope = z.infer<typeof connectionScopeSchema>;

/**
 * 接続先（CONN）。認証情報の値は DB に保存しない（CONN-02）。
 * - studio:       Agent Studio の Secrets Manager（studio_function 用）
 * - openai_vault: OpenAI の vault（公開 MCP 用）
 * - runtime:      顧客 Runtime の Secrets Manager（値は顧客が自社 AWS で登録する）
 */
export const createConnectionSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(1000).optional(),
    connector_id: z.uuid().optional(),
    scope: connectionScopeSchema,
    /** scope=runtime のとき必須 */
    runtime_id: z.uuid().optional(),
    /** scope=runtime のとき: Runtime 側のシークレット名 */
    runtime_secret_name: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    /** scope=studio のとき: 送信するヘッダ名（例: Authorization） */
    header_name: z
      .string()
      .regex(/^[A-Za-z0-9-]+$/)
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.scope === "runtime" && (!v.runtime_id || !v.runtime_secret_name)) {
      ctx.addIssue({ code: "custom", message: "Runtime とシークレット名を指定してください", path: ["runtime_id"] });
    }
  });
export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;

export const githubAppPermissionsSchema = z.object({
  /** 企業専用Integration Repositoryを自動作成する場合だけ使用する。 */
  administration: z.literal("write").optional(),
  contents: z.literal("write"),
  pull_requests: z.literal("write"),
  checks: z.literal("read"),
  metadata: z.literal("read"),
}).strict();

/** GitHub Appの秘密値は書き込み専用で、Connection DTOへは一切返さない。 */
export const createGitHubAppConnectionSchema = z.object({
  name: z.string().trim().min(1).max(100),
  app_id: z.string().regex(/^\d+$/).max(30),
  private_key: z.string().min(100).max(20000),
  webhook_secret: z.string().min(16).max(2000),
  installation_id: z.string().regex(/^\d+$/).max(30),
  repository_id: z.string().regex(/^\d+$/).max(30),
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  repository: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  /** 接続時にGitHub APIからdefault branchを取得する。未指定時の仮値はmain。 */
  base_branch: z.string().regex(/^[A-Za-z0-9._/-]+$/).max(200).default("main"),
  /** Adapter CIがattestationへ署名するEd25519公開鍵（秘密値ではない）。 */
  package_signing_public_key: z.string().includes("BEGIN PUBLIC KEY").min(80).max(10000),
  permissions: githubAppPermissionsSchema.default({ administration: "write", contents: "write", pull_requests: "write", checks: "read", metadata: "read" }),
}).strict();
export type CreateGitHubAppConnectionInput = z.input<typeof createGitHubAppConnectionSchema>;

export interface GitHubAppConnectionMetadata {
  provider: "github_app";
  app_id: string;
  installation_id: string;
  repository_id: string;
  owner: string;
  repository: string;
  base_branch: string;
  repository_url: string;
  /** Agent Studio本体と企業専用Toolの保存先を混同しない。 */
  repository_purpose?: "agent_studio_core" | "organization_integrations";
  package_signing_public_key: string;
  permissions: z.infer<typeof githubAppPermissionsSchema>;
}

/** 認証情報の値を設定する（書き込み専用。読み出す API はない） */
export const setConnectionSecretSchema = z
  .object({
    value: z.string().min(1).max(10000),
    /** 任意の有効期限。期限を過ぎるとWorkerが自動で利用不可にする */
    expires_at: z.iso.datetime().optional(),
    /** scope=openai_vault のとき必須: この認証情報を使う MCP サーバーの URL（OpenAI の vault は URL で照合する） */
    mcp_server_url: z.url().optional(),
  })
  .strict();
export type SetConnectionSecretInput = z.infer<typeof setConnectionSecretSchema>;

/** Qiita OAuth callbackの認可コード。tokenはAPI側で交換し、レスポンスへ出さない。 */
export const exchangeQiitaOAuthSchema = z.object({ code: z.string().min(1).max(2000) }).strict();
export type ExchangeQiitaOAuthInput = z.infer<typeof exchangeQiitaOAuthSchema>;

/** 外部サービス側で一度だけ発行するOAuth applicationの設定。Secretは書き込み専用。 */
export const setConnectorOAuthAppSchema = z
  .object({
    client_id: z.string().trim().min(1).max(500),
    client_secret: z.string().min(1).max(2000),
  })
  .strict();
export type SetConnectorOAuthAppInput = z.infer<typeof setConnectorOAuthAppSchema>;

/** Provider OAuthの開始。stateとPKCE verifierはフロントの封印cookieで保持し、APIはURLだけ組み立てる。 */
export const connectorOAuthStartSchema = z
  .object({
    redirect_uri: z.url(),
    state: z.string().min(16).max(256),
    code_challenge: z.string().min(16).max(256).optional(),
  })
  .strict();
export type ConnectorOAuthStartInput = z.infer<typeof connectorOAuthStartSchema>;

export interface ConnectorOAuthStartDto {
  authorize_url: string;
  scopes: string[];
}

/** callbackで受け取った認可コード。tokenはAPI側で交換し、レスポンスへ出さない。 */
export const connectorOAuthExchangeSchema = z
  .object({
    code: z.string().min(1).max(2000),
    redirect_uri: z.url(),
    code_verifier: z.string().min(16).max(256).optional(),
  })
  .strict();
export type ConnectorOAuthExchangeInput = z.infer<typeof connectorOAuthExchangeSchema>;

/** Provider Catalogの公開情報。画面が「接続して続ける」を出すためだけに使う。 */
export interface ProviderCatalogEntryDto {
  key: string;
  name: string;
  description: string;
  auth_kind: "none" | "static_bearer" | "oauth2" | "github_app";
  /** 実行にSelf-hosted Runtimeが必要か */
  requires_self_hosted: boolean;
  /** この組織で既に登録済みのConnector ID */
  connector_id: string | null;
  /** OAuth アプリを登録する Provider 側の管理画面（oauth2 のみ） */
  oauth_console_url: string | null;
}

export interface ConnectorOAuthAppDto {
  connector_id: string;
  provider: string;
  configured: boolean;
  client_id: string | null;
  has_client_secret: boolean;
}

export interface ConnectionDto {
  id: string;
  name: string;
  description: string | null;
  connector_id: string | null;
  scope: ConnectionScope;
  runtime_id: string | null;
  runtime_secret_name: string | null;
  header_name: string | null;
  metadata: Record<string, unknown>;
  has_secret: boolean;
  status: "connected" | "expired" | "revoked" | "error";
  last_validated_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export const createAgentScheduleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  stage: stageSchema,
  input: z.string().trim().min(1).max(20000),
  timezone: z.literal("Asia/Tokyo").default("Asia/Tokyo"),
  local_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  days_of_week: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  enabled: z.boolean().default(true),
}).strict();
export type CreateAgentScheduleInput = z.input<typeof createAgentScheduleSchema>;

export const updateAgentScheduleSchema = createAgentScheduleSchema.partial().strict();
export type UpdateAgentScheduleInput = z.input<typeof updateAgentScheduleSchema>;

export interface AgentScheduleDto {
  id: string;
  agent_id: string;
  name: string;
  stage: Stage;
  input: string;
  timezone: "Asia/Tokyo";
  local_time: string;
  days_of_week: number[];
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
  last_run_id: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------
export const agentVersionStatusSchema = z.enum(["draft", "published", "archived"]);
export type AgentVersionStatus = z.infer<typeof agentVersionStatusSchema>;

export interface AgentVersionDto {
  id: string;
  version: number;
  status: AgentVersionStatus;
  manifest: AgentManifest;
  manifest_yaml: string;
  created_by: string | null;
  created_at: string;
  published_at: string | null;
}

export interface AgentDto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  project_brief: string | null;
  capability_resolution: CapabilityResolutionDto;
  /** ブラウザで接続してよい範囲。ブラウザを使わない Agent では使われない */
  browser_access: BrowserAccess;
  browser_allowed_domains: string[];
  latest_version: number;
  published_version: number | null;
  /** 最新の作成Job。Agent一覧では内部Jobを展開せず状態だけを見せる。 */
  builder_project_id: string | null;
  builder_status: BuilderProjectStatus | null;
  builder_error: string | null;
  created_at: string;
  updated_at: string;
  versions?: AgentVersionDto[];
}

export const browserAccessSchema = z.enum(["restricted", "public"]);
export type BrowserAccess = z.infer<typeof browserAccessSchema>;

/** ブラウザで接続してよい範囲の設定。安全の境界なので、業務の設定値とは分けて持つ */
export const setBrowserAccessSchema = z
  .object({
    access: browserAccessSchema,
    allowed_domains: z.array(z.string().trim().min(1).max(253)).max(100).default([]),
  })
  .strict()
  .refine((v) => v.access !== "restricted" || v.allowed_domains.length > 0, {
    message: "接続を許すドメインを1つ以上入力してください",
    path: ["allowed_domains"],
  });
export type SetBrowserAccessInput = z.input<typeof setBrowserAccessSchema>;

export const capabilityStateSchema = z.enum(["resolved", "needs_connection", "missing", "ambiguous"]);
export type CapabilityState = z.infer<typeof capabilityStateSchema>;
/** 能力ごとに利用者へ尋ねる設定値。name は指示文への差し込み用で、画面には label を出す。 */
export interface CapabilityVariableDto {
  name: string;
  label: string;
  description: string;
  example: string | null;
  required: boolean;
}
export type CapabilityFulfillmentMode =
  | "model"
  | "reuse"
  | "configure"
  | "shared_provider_adapter"
  | "organization_private_adapter"
  /** 2026-09以前に保存した計画との後方互換。新規計画は上のadapter名を使う。 */
  | "shared_tool"
  | "organization_tool";

/**
 * 利用者の目的を実行可能にするため、Builderがどこで能力を用意するか。
 * 実装方式（OpenAPI/MCP/コード）は内部詳細であり、通常画面では mode を説明に使う。
 */
export interface CapabilityFulfillmentDto {
  mode: CapabilityFulfillmentMode;
  owner: "model" | "agent_studio" | "organization";
  execution_location: "model" | "studio" | "runtime";
  reason: string;
  /** shared_provider_adapterをmainへmergeした後、利用可能通知までの運用目標。保証時間ではない。 */
  availability_target_minutes: number | null;
}
export interface CapabilityRequirementDto {
  requirement: string;
  state: CapabilityState;
  connector_id: string | null;
  connector_name: string | null;
  tool_names: string[];
  confidence: number;
  reason: string;
  /** この能力を使うために利用者が入力する値。能力に紐づかない設定値は作らない。 */
  variables: CapabilityVariableDto[];
  /** 旧レコードとの互換性のためoptional。Builder再計画時に必ず付与する。 */
  fulfillment?: CapabilityFulfillmentDto;
}
export interface CapabilityResolutionDto {
  requirements: CapabilityRequirementDto[];
  selected_tools: string[];
  /** requirements の required な variables から導出する。Build の前提条件の判定に使う。 */
  missing_variables: string[];
  ready: boolean;
}

export const createAgentSchema = z.object({ manifest: z.string().min(1).max(200000) }).strict();
export type CreateAgentInput = z.infer<typeof createAgentSchema>;

export const createAgentVersionSchema = createAgentSchema;

export const generateManifestSchema = z
  .object({
    /** 日本語での業務の説明 */
    description: z.string().trim().min(5).max(4000),
  })
  .strict();
export type GenerateManifestInput = z.infer<typeof generateManifestSchema>;

export interface GenerateManifestResultDto {
  manifest_yaml: string;
  /** 生成時の補足（使えるツールが足りない、など） */
  notes: string[];
  resolution: CapabilityResolutionDto;
}

export const createAgentProjectSchema = generateManifestSchema.extend({
  target: z.enum(["preview", "production"]).default("preview"),
}).strict();
export type CreateAgentProjectInput = z.infer<typeof createAgentProjectSchema>;

export const linkAgentConnectionSchema = z
  .object({
    stage: stageSchema,
    connector_id: z.uuid(),
    connection_id: z.uuid(),
    allowed_capabilities: z.array(toolNameSchema).min(1).max(100),
  })
  .strict();
export type LinkAgentConnectionInput = z.infer<typeof linkAgentConnectionSchema>;

export const setAgentEnvironmentSchema = z
  .object({
    stage: stageSchema,
    variables: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.string().max(10000)).default({}),
  })
  .strict();
export type SetAgentEnvironmentInput = z.infer<typeof setAgentEnvironmentSchema>;

/** Project Settingsから変更できる、Secretを含まないAgent定義。保存時はImmutableな新Versionを作る。 */
export const updateAgentSettingsSchema = z
  .object({
    base_version: z.number().int().min(1),
    instructions: z.string().trim().min(1).max(32000),
    policies: z.array(policySchema).max(64).default([]),
    environment_profile: slugSchema.nullable(),
  })
  .strict();
export type UpdateAgentSettingsInput = z.infer<typeof updateAgentSettingsSchema>;

export interface AgentConnectionLinkDto {
  id: string;
  stage: Stage;
  connector: { id: string; key: string; name: string };
  connection: { id: string; name: string; status: ConnectionDto["status"]; has_secret: boolean };
  allowed_capabilities: string[];
}

export interface AgentEnvironmentConfigDto {
  stage: Stage;
  variables: Record<string, string>;
}

export interface AgentBuildDto {
  id: string;
  build_number: number;
  status: "ready" | "failed";
  agent_version_id: string;
  runtime_profile_id: string;
  resolution: CapabilityResolutionDto;
  build_log: { type: "info" | "success" | "warning" | "error"; message: string }[];
  created_at: string;
}

export interface AgentProjectDto {
  agent: AgentDto;
  build_jobs: BuilderProjectDto[];
  connection_links: AgentConnectionLinkDto[];
  environments: AgentEnvironmentConfigDto[];
  builds: AgentBuildDto[];
  deployments: DeploymentDto[];
  preview_url: string | null;
  preview_api_url: string | null;
}

export interface CreateAgentProjectResultDto extends AgentProjectDto {
  auto_preview_created: boolean;
}

export interface ManifestValidationDto {
  ok: boolean;
  errors: { path: string; message: string }[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// 実行環境・Runtime
// ---------------------------------------------------------------------------
export const openAiTemplateSchema = z.enum(["general-python", "browser-basic", "data-analysis", "document-processing"]);
export type OpenAiTemplate = z.infer<typeof openAiTemplateSchema>;

const hostnameSchema = z
  .string()
  .regex(/^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/, "ホスト名の形式が正しくありません");

export const networkPolicySchema = z
  .object({
    mode: z.enum(["enabled", "disabled", "restricted"]),
    allowed_domains: z.array(hostnameSchema).min(1).max(100).optional(),
  })
  .strict()
  .refine((v) => v.mode !== "restricted" || (v.allowed_domains?.length ?? 0) > 0, {
    message: "許可するドメインを1件以上指定してください",
    path: ["allowed_domains"],
  });
export type NetworkPolicy = z.infer<typeof networkPolicySchema>;

export const runtimeProfileTypeSchema = z.enum(["none", "openai_hosted", "self_hosted"]);
export type RuntimeProfileType = z.infer<typeof runtimeProfileTypeSchema>;

export const createRuntimeProfileSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none"), key: slugSchema, name: z.string().trim().min(1).max(100) }).strict(),
  z
    .object({
      type: z.literal("openai_hosted"),
      key: slugSchema,
      name: z.string().trim().min(1).max(100),
      template: openAiTemplateSchema,
      network: networkPolicySchema.default({ mode: "disabled" }),
    })
    .strict(),
  z
    .object({
      type: z.literal("self_hosted"),
      key: slugSchema,
      name: z.string().trim().min(1).max(100),
      runtime_id: z.uuid(),
    })
    .strict(),
]);
export type CreateRuntimeProfileInput = z.input<typeof createRuntimeProfileSchema>;

export interface RuntimeProfileDto {
  id: string;
  key: string;
  name: string;
  type: RuntimeProfileType;
  template: OpenAiTemplate | null;
  network: NetworkPolicy | null;
  runtime: RuntimeSummaryDto | null;
  created_at: string;
}

export const runtimeStatusSchema = z.enum(["provisioning", "pending", "active", "degraded", "offline", "revoked"]);
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;

export const provisioningTypeSchema = z.enum(["studio_managed", "customer_owned"]);
export type ProvisioningType = z.infer<typeof provisioningTypeSchema>;

export const createRuntimeSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    stage: stageSchema,
    provisioning_type: provisioningTypeSchema,
    aws_account_id: z.string().regex(/^\d{12}$/, "12桁の数字で入力してください"),
    aws_region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, "リージョンの形式が正しくありません"),
    expected_role_name: z
      .string()
      .regex(/^[\w+=,.@-]{1,64}$/, "IAM ロール名の形式が正しくありません"),
  })
  .strict();
export type CreateRuntimeInput = z.infer<typeof createRuntimeSchema>;

export const managedRuntimeProvisioningStatusSchema = z.enum([
  "queued",
  "account_creating",
  "infrastructure_applying",
  "bootstrap_configuring",
  "connecting",
  "completed",
  "failed",
]);
export type ManagedRuntimeProvisioningStatus = z.infer<typeof managedRuntimeProvisioningStatusSchema>;

export const createManagedRuntimeEnvironmentSchema = z
  .object({
    key: slugSchema,
    name: z.string().trim().min(1).max(100),
    runtime_name: z.string().trim().min(1).max(100),
    stage: stageSchema,
    aws_region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, "リージョンの形式が正しくありません"),
  })
  .strict();
export type CreateManagedRuntimeEnvironmentInput = z.infer<typeof createManagedRuntimeEnvironmentSchema>;

export interface ManagedRuntimeProvisioningDto {
  status: ManagedRuntimeProvisioningStatus;
  step: string;
  progress: number;
  error: string | null;
  can_retry: boolean;
  started_at: string | null;
  completed_at: string | null;
}

export interface RuntimeSummaryDto {
  id: string;
  name: string;
  stage: Stage;
  provisioning_type: ProvisioningType;
  status: RuntimeStatus;
}

export interface RuntimeDto extends RuntimeSummaryDto {
  aws_account_id: string | null;
  aws_region: string;
  expected_role_name: string;
  controller_version: string | null;
  last_heartbeat_at: string | null;
  registered_at: string | null;
  tools: { name: string; description: string; risk: ToolRisk; reads_untrusted_content: boolean }[];
  provisioning: ManagedRuntimeProvisioningDto | null;
  created_at: string;
}

export interface ManagedRuntimeEnvironmentDto {
  profile: RuntimeProfileDto;
  runtime: RuntimeDto;
}

export interface BootstrapTokenDto {
  /** 平文はこのレスポンスでしか返さない */
  token: string;
  expires_at: string;
}

// ---------------------------------------------------------------------------
// デプロイ・実行
// ---------------------------------------------------------------------------
export const createDeploymentSchema = z
  .object({
    agent_version_id: z.uuid(),
    runtime_profile_id: z.uuid(),
    stage: stageSchema,
  })
  .strict();
export type CreateDeploymentInput = z.infer<typeof createDeploymentSchema>;

export const deploymentStatusSchema = z.enum(["active", "superseded", "archived"]);
export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;

export interface DeploymentDto {
  id: string;
  agent: { id: string; key: string; name: string };
  agent_version: number;
  agent_version_id: string;
  runtime_profile: { id: string; key: string; name: string; type: RuntimeProfileType };
  build_id: string | null;
  build_number: number | null;
  promoted_from_id: string | null;
  stage: Stage;
  status: DeploymentStatus;
  health_status: "ready" | "degraded" | "failed";
  created_by: string | null;
  created_at: string;
}

export const runStatusSchema = z.enum([
  "queued",
  "provisioning",
  "running",
  "waiting_approval",
  /** Agent が利用者へ質問して返答を待っている。終端ではない */
  "waiting_input",
  "requires_action",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runOutcomeSchema = z.enum(["pending", "succeeded", "completed_with_errors", "failed", "cancelled"]);
export type RunOutcome = z.infer<typeof runOutcomeSchema>;

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "failed", "cancelled"];

export const createRunSchema = z
  .object({
    deployment_id: z.uuid(),
    input: z.string().trim().min(1).max(20000),
  })
  .strict();
export type CreateRunInput = z.infer<typeof createRunSchema>;

export const sendRunMessageSchema = z.object({ input: z.string().trim().min(1).max(20000) }).strict();

export const runEventTypeSchema = z.enum([
  "run.status",
  "environment.status",
  "message",
  "tool.call",
  "tool.result",
  "external.job",
  "approval.requested",
  "approval.decided",
  "usage",
  "error",
  "openai.event",
]);
export type RunEventType = z.infer<typeof runEventTypeSchema>;

export interface RunEventDto {
  seq: number;
  type: RunEventType;
  summary: string;
  data: unknown;
  created_at: string;
}

export interface RunDto {
  id: string;
  status: RunStatus;
  outcome: RunOutcome;
  input: string;
  output: string | null;
  error: string | null;
  deployment: { id: string; stage: Stage };
  agent: { id: string; key: string; name: string; version: number };
  runtime_profile: { id: string; key: string; name: string; type: RuntimeProfileType };
  requested_by: string | null;
  requested_by_email: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  external_jobs: Array<{
    id: string;
    provider_job_id: string;
    source_tool: string;
    status: "pending" | "processing" | "succeeded" | "failed" | "unknown";
    attempts: number;
    last_checked_at: string | null;
    provider_post_id: string | null;
    permalink: string | null;
  }>;
  events?: RunEventDto[];
}

/** 実行の成果物（S3 に保存したもの）。download_url は5分だけ有効 */
export interface RunArtifactDto {
  id: string;
  path: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  scan_status: "pending" | "passed" | "rejected" | "failed";
  retained_until: string;
  /** scan_status=passedかつ保持期限内だけ発行する。 */
  download_url: string | null;
}

export const createBrowserProfileSchema = z.object({
  runtime_id: z.uuid().optional(),
  project_id: z.uuid().optional(),
  provider_key: z.string().trim().min(1).max(100).regex(/^[a-z0-9][a-z0-9_-]*$/),
  display_name: z.string().trim().min(1).max(100),
  environment: z.enum(["staging", "production"]),
  allowed_domains: z.array(z.string().trim().min(1).max(253)).min(1).max(20),
}).strict();
export type CreateBrowserProfileInput = z.input<typeof createBrowserProfileSchema>;

export interface BrowserProfileDto {
  id: string;
  runtime_id: string;
  project_id: string | null;
  provider_key: string;
  display_name: string;
  environment: "staging" | "production";
  allowed_domains: string[];
  status: "pending" | "active" | "expired" | "revoked";
  last_verified_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface BrowserLoginSessionDto {
  id: string;
  profile_id: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
  expires_at: string;
  completed_at: string | null;
  error: string | null;
  /** UIの認証済みrelay route。password/MFA/cookieをAPIへ返さない。 */
  launch_path: string;
}

export interface BrowserRelayTicketDto {
  session_id: string;
  token: string;
  websocket_url: string;
  expires_at: string;
}

export const createDeploymentCredentialSchema = z.object({
  name: z.string().trim().min(1).max(100),
  rate_limit_per_minute: z.number().int().min(1).max(600).default(60),
  max_runs_per_day: z.number().int().min(1).max(100_000).default(1_000),
  expires_at: z.iso.datetime().optional(),
}).strict();
export type CreateDeploymentCredentialInput = z.input<typeof createDeploymentCredentialSchema>;

export interface DeploymentApiKeyDto {
  id: string;
  deployment_id: string;
  name: string;
  key_prefix: string;
  status: "active" | "revoked";
  rate_limit_per_minute: number;
  max_runs_per_day: number;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface CreatedDeploymentApiKeyDto extends DeploymentApiKeyDto { secret: string }

export interface DeploymentWebhookDto {
  id: string;
  deployment_id: string;
  name: string;
  status: "active" | "revoked";
  rate_limit_per_minute: number;
  max_runs_per_day: number;
  last_used_at: string | null;
  created_at: string;
}

export interface CreatedDeploymentWebhookDto extends DeploymentWebhookDto { signing_secret: string; path: string }

export const deploymentTriggerInputSchema = z.object({ input: z.string().trim().min(1).max(100_000) }).strict();

// ---------------------------------------------------------------------------
// 承認
// ---------------------------------------------------------------------------
export const approvalDecisionSchema = z
  .object({ decision: z.enum(["approve", "deny"]), comment: z.string().max(1000).optional() })
  .strict();
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;

export interface ApprovalDto {
  id: string;
  run_id: string | null;
  source: string;
  tool: string;
  args_preview: string;
  reason: string;
  status: ApprovalStatus;
  requested_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  comment: string | null;
  auto_approved: boolean;
  auto_approval_policy_id: string | null;
  auto_approval_policy_version: number | null;
  auto_approval_reason: string | null;
  agent: { id: string; name: string } | null;
}

// ---------------------------------------------------------------------------
// Builder Agent（作成作業。日常業務を実行する Agent とは分離）
// ---------------------------------------------------------------------------
export const builderProjectStatusSchema = z.enum([
  "draft",
  "analyzing",
  "discovering",
  "planning",
  "waiting_human_action",
  "implementing",
  "validating",
  "previewing",
  "ready_for_production",
  "production_pending_approval",
  "completed",
  "blocked",
  "failed",
  "cancelled",
]);
export type BuilderProjectStatus = z.infer<typeof builderProjectStatusSchema>;
export const builderTargetSchema = z.enum(["preview", "production"]);
export type BuilderTarget = z.infer<typeof builderTargetSchema>;

export const createBuilderProjectSchema = z
  .object({
    request: z.string().trim().min(20).max(20_000),
    target: builderTargetSchema.default("preview"),
  })
  .strict();
export type CreateBuilderProjectInput = z.input<typeof createBuilderProjectSchema>;

export const builderOpenApiInputSchema = z
  .object({
    document: z.record(z.string(), z.unknown()),
    source_url: z.url().refine((url) => url.startsWith("https://"), "https の URL を指定してください").optional(),
    connector_key: slugSchema.optional(),
    connector_name: z.string().trim().min(1).max(100).optional(),
    selected_operation_ids: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
    /** 社内データ用APIとして、response schemaとfield allowlistを必須化する。 */
    internal_api: z.boolean().default(false),
  })
  .strict();
export type BuilderOpenApiInput = z.input<typeof builderOpenApiInputSchema>;

export const builderMcpInputSchema = z
  .object({
    server_url: z.url().refine((url) => url.startsWith("https://"), "https の URL を指定してください"),
    connector_key: slugSchema.optional(),
    connector_name: z.string().trim().min(1).max(100).optional(),
    auth_type: z.enum(["none", "static_bearer"]).default("none"),
    selected_tool_names: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
    expected_content_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .strict();
export type BuilderMcpInput = z.input<typeof builderMcpInputSchema>;

export interface BuilderMcpOperationDto extends ConnectorOperationInput {
  remote_name: string;
  selected: boolean;
  input_schema: ToolInputSchema;
  read_only: boolean | null;
  destructive: boolean;
}

export interface BuilderMcpProposalDto {
  source: {
    title: string;
    spec_version: "MCP";
    source_url: string;
    content_hash: string;
  };
  connector: {
    key: string;
    name: string;
    description: string;
    adapter: "mcp";
    base_url: string;
    auth_type: "none" | "static_bearer";
  };
  authentication: {
    kind: "none" | "bearer";
    requires_human_action: boolean;
  };
  operations: BuilderMcpOperationDto[];
  warnings: string[];
}

export interface BuilderOpenApiOperationDto extends ConnectorOperationInput {
  operation_id: string;
  selected: boolean;
  method: NonNullable<ConnectorOperationInput["method"]>;
  path: string;
  input_schema: NonNullable<ConnectorOperationInput["input_schema"]>;
}

export interface BuilderOpenApiProposalDto {
  source: {
    title: string;
    spec_version: string;
    source_url: string | null;
    content_hash: string;
  };
  connector: {
    key: string;
    name: string;
    description: string;
    adapter: "http_openapi" | "internal_http_api";
    base_url: string;
    auth_type: ConnectorAuthType;
    default_headers?: Record<string, string>;
  };
  authentication: {
    kind: "none" | "header_api_key" | "bearer" | "oauth2";
    header_name: string | null;
    scopes: string[];
    requires_human_action: boolean;
  };
  operations: BuilderOpenApiOperationDto[];
  warnings: string[];
}

export const humanActionTypeSchema = z.enum([
  "oauth_consent",
  "enter_secret",
  "provider_app_registration",
  "human_login",
  "aws_admin_action",
  "business_rule_confirmation",
  "repository_merge",
  "adapter_delivery",
  "production_approval",
]);
export type HumanActionType = z.infer<typeof humanActionTypeSchema>;

export const completeBuilderHumanActionSchema = z
  .object({ answers: z.record(z.string(), z.string().trim().max(4000)).default({}) })
  .strict();
export type CompleteBuilderHumanActionInput = z.input<typeof completeBuilderHumanActionSchema>;

export interface BuilderStepDto {
  id: string;
  kind: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  attempts: number;
  error_class: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface BuilderRunDto {
  id: string;
  attempt: number;
  status: "queued" | "running" | "waiting_human_action" | "completed" | "failed" | "cancelled";
  correlation_id: string;
  error_class: string | null;
  error: string | null;
  error_fingerprint: string | null;
  retryable: boolean | null;
  next_action: string | null;
  not_before: string | null;
  last_evidence_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  steps: BuilderStepDto[];
}

export interface CapabilityGapDto {
  id: string;
  requirement: string;
  gap_type: "missing" | "ambiguous" | "needs_connection" | "unsupported";
  resolution_strategy: "reuse" | "configure" | "generate_declarative" | "generate_code" | "browser" | "unsupported";
  status: "open" | "resolved" | "dismissed";
  detail: unknown;
}

export interface CapabilityPlanDto {
  id: string;
  version: number;
  requirements: CapabilityRequirementDto[];
  graph: {
    nodes: Array<{
      id: string;
      label: string;
      state: CapabilityState;
      strategy: CapabilityGapDto["resolution_strategy"];
      fulfillment?: CapabilityFulfillmentDto;
    }>;
    edges: Array<{ from: string; to: string }>;
  };
  risks: string[];
  execution_locations: string[];
  /** Builderが決めた実行環境。planning前はnull */
  environment_plan: EnvironmentPlanDto | null;
  created_at: string;
}

export interface HumanActionDto {
  id: string;
  type: HumanActionType;
  title: string;
  reason: string;
  assignee_role: MemberRole;
  fields: Array<{
    name: string;
    label: string;
    secret: boolean;
    required?: boolean;
    placeholder?: string;
    description?: string;
    options?: Array<{ value: string; label: string }>;
    /** 技術的な任意項目。画面では「詳細設定」に畳む */
    advanced?: boolean;
  }>;
  instructions: string[];
  resume_condition: unknown;
  response: Record<string, string> | null;
  status: "pending" | "completed" | "expired" | "rejected";
  completed_at: string | null;
  expires_at: string | null;
  created_at: string;
  /** 以下は画面が設定画面へ遷移せずに操作を完結させるための補助情報（任意） */
  connector_id?: string;
  /** Builderが事前作成したConnection。認証情報だけを入力すれば使える */
  connection_id?: string;
  /** OAuth同意を開始するURL（フロントのroute。外部URLはAPIが組み立てる） */
  oauth_start_url?: string;
  oauth_app_configured?: boolean;
  /** Provider側でOAuth Appを登録する管理画面 */
  oauth_app_console_url?: string;
  scopes?: string[];
  secret_header_name?: string;
  /** scope=openai_vault のConnectionで必要 */
  mcp_server_url?: string;
  /** APIキーの取得方法を説明する公式ページ */
  secret_help_url?: string;
  /** Self-hosted Runtimeが必要なときにBuilderが用意した構成案 */
  prepared_plan?: EnvironmentPlanDto;
  /** 画面操作の代わりに、そのまま実行できる CLI コマンド（秘密の値は含めない） */
  cli_command?: string;
}

/** Builderが決めた実行環境の構成。利用者には読み取り専用で「実行場所・外部通信・理由」を見せる。 */
export interface EnvironmentPlanDto {
  kind: "openai_hosted" | "self_hosted";
  template: OpenAiTemplate | null;
  network: NetworkPolicy | null;
  profile_key: string;
  profile_name: string;
  execution_location: "model" | "studio" | "runtime";
  /** 許可した外部送信先（Connectorのorigin） */
  egress: string[];
  reason: string;
  requires_human: false | "aws_admin_action";
}

/** Human Actionの自動再開条件。文字列判定を1箇所に集める。 */
export const builderResumeConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("connector_connected"), connector_id: z.string() }).loose(),
  z.object({ type: z.literal("connection_status"), connector_id: z.string(), connection_id: z.string().optional(), stage: z.string().optional(), status: z.string().optional() }).loose(),
  z.object({ type: z.literal("builder_answers"), topic: z.string() }).loose(),
  z.object({ type: z.literal("capability_selected"), requirement: z.string() }).loose(),
  z.object({ type: z.literal("github_repository_connected") }).loose(),
  z.object({ type: z.literal("runtime_active"), runtime_id: z.string() }).loose(),
  z.object({ type: z.literal("browser_runtime_ready") }).loose(),
  z.object({ type: z.literal("code_workspace_runtime_ready") }).loose(),
  z.object({ type: z.literal("browser_profile_ready"), domain: z.string() }).loose(),
  z.object({ type: z.literal("git_branch_published") }).loose(),
  z.object({ type: z.literal("git_pr_merged") }).loose(),
  z.object({ type: z.literal("adapter_registered") }).loose(),
  z.object({ type: z.literal("production_approval") }).loose(),
]);
export type BuilderResumeCondition = z.infer<typeof builderResumeConditionSchema>;

export interface BuilderDiscoverySourceDto {
  id: string;
  kind: string;
  title: string;
  spec_version: string | null;
  source_url: string | null;
  content_hash: string;
  metadata: unknown;
  created_at: string;
}

export interface BuilderChangeSetDto {
  id: string;
  kind: string;
  status: "planned" | "applied" | "pr_open" | "merged" | "failed" | "rejected";
  summary: string;
  risk: ToolRisk;
  artifacts: Array<{ type: string; id: string; name: string; version?: number }>;
  source_hash: string | null;
  created_at: string;
}

export interface BuilderValidationRunDto {
  id: string;
  suite: "schema" | "contract" | "security" | "smoke" | "preview" | "ci" | "eval" | "drift" | "code_workspace";
  environment: "builder" | "preview" | "production";
  status: "running" | "passed" | "failed" | "blocked";
  evidence: unknown;
  error_class: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface BuilderReleaseDto {
  id: string;
  status: "preview_running" | "preview_succeeded" | "preview_failed" | "preview_cancelled" | "production_pending_approval" | "production_running" | "production_succeeded" | "production_failed" | "rolled_back";
  agent_id: string;
  build_id: string;
  preview_deployment_id: string;
  preview_run_id: string | null;
  production_deployment_id: string | null;
  production_run_id: string | null;
  rollback_target_deployment_id: string | null;
  config_hash: string;
  required_tools: string[];
  created_at: string;
  finished_at: string | null;
}

export interface BuilderProjectDto {
  id: string;
  agent_id: string | null;
  request: string;
  target: BuilderTarget;
  status: BuilderProjectStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  latest_plan: CapabilityPlanDto | null;
  gaps: CapabilityGapDto[];
  human_actions: HumanActionDto[];
  discovery_sources: BuilderDiscoverySourceDto[];
  change_sets: BuilderChangeSetDto[];
  validation_runs: BuilderValidationRunDto[];
  releases: BuilderReleaseDto[];
  runs: BuilderRunDto[];
}

export interface ApplyBuilderOpenApiResultDto {
  project: BuilderProjectDto;
  connector: ConnectorDto;
}

export interface ApplyBuilderMcpResultDto {
  project: BuilderProjectDto;
  connector: ConnectorDto;
}

// ---------------------------------------------------------------------------
// Workflow（WF）
// ---------------------------------------------------------------------------
const workflowTransitionSchema = {
  next: slugSchema.optional(),
  retries: z.number().int().min(0).max(5).optional(),
  compensate: slugSchema.optional(),
};

export const workflowConditionSchema = z
  .object({
    source: z.enum(["input", "step"]),
    step_key: slugSchema.optional(),
    path: z.string().trim().max(500).default(""),
    operator: z.enum(["eq", "ne", "lt", "lte", "gt", "gte", "exists", "in"]),
    value: z.unknown().optional(),
  })
  .strict()
  .refine((value) => value.source !== "step" || Boolean(value.step_key), { message: "stepを参照するときはstep_keyが必要です" });
export type WorkflowCondition = z.infer<typeof workflowConditionSchema>;

export const workflowStepSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("agent"),
      key: slugSchema,
      name: z.string().trim().min(1).max(100),
      deployment_id: z.uuid(),
      /** {{input}} や {{steps.<key>.output}} を埋め込める */
      input_template: z.string().min(1).max(20000),
      ...workflowTransitionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("tool"),
      key: slugSchema,
      name: z.string().trim().min(1).max(100),
      deployment_id: z.uuid(),
      tool_name: toolNameSchema,
      /** JSON引数。テンプレート展開後もJSON objectでなければ実行しない。 */
      arguments_template: z.string().min(2).max(20000),
      ...workflowTransitionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("condition"),
      key: slugSchema,
      name: z.string().trim().min(1).max(100),
      condition: workflowConditionSchema,
      if_true: slugSchema,
      if_false: slugSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("approval"),
      key: slugSchema,
      name: z.string().trim().min(1).max(100),
      message: z.string().min(1).max(2000),
      next: slugSchema.optional(),
      on_denied: slugSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("transform"),
      key: slugSchema,
      name: z.string().trim().min(1).max(100),
      output_template: z.string().min(1).max(20000),
      next: slugSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("wait"),
      key: slugSchema,
      name: z.string().trim().min(1).max(100),
      seconds: z.number().int().min(0).max(604800),
      next: slugSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("compensate"),
      key: slugSchema,
      name: z.string().trim().min(1).max(100),
      deployment_id: z.uuid(),
      input_template: z.string().min(1).max(20000),
      next: slugSchema.optional(),
      retries: z.number().int().min(0).max(5).optional(),
    })
    .strict(),
]);
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

export const workflowDefinitionSchema = z
  .object({ version: z.literal(2).optional(), start: slugSchema.optional(), steps: z.array(workflowStepSchema).min(1).max(50) })
  .strict()
  .superRefine((definition, context) => {
    const keys = definition.steps.map((step) => step.key);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: "custom", message: "ステップのキーが重複しています", path: ["steps"] });
      return;
    }
    const keySet = new Set(keys);
    const start = definition.start ?? keys[0];
    if (start && !keySet.has(start)) context.addIssue({ code: "custom", message: "開始ステップが見つかりません", path: ["start"] });
    const refs = (step: z.infer<typeof workflowStepSchema>): string[] => {
      if (step.type === "condition") return [step.if_true, step.if_false];
      if (step.type === "approval") return [step.next, step.on_denied].filter((value): value is string => Boolean(value));
      return [step.next, "compensate" in step ? step.compensate : undefined].filter((value): value is string => Boolean(value));
    };
    definition.steps.forEach((step, index) => {
      for (const ref of refs(step)) if (!keySet.has(ref)) context.addIssue({ code: "custom", message: `遷移先 ${ref} が見つかりません`, path: ["steps", index] });
      if (step.type === "condition" && step.condition.source === "step" && step.condition.step_key && !keySet.has(step.condition.step_key)) {
        context.addIssue({ code: "custom", message: `参照ステップ ${step.condition.step_key} が見つかりません`, path: ["steps", index, "condition"] });
      }
    });
  });
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export const createWorkflowSchema = z
  .object({ key: slugSchema, name: z.string().trim().min(1).max(100), definition: workflowDefinitionSchema })
  .strict();
export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;

export const workflowRunStatusSchema = z.enum(["running", "waiting_approval", "waiting_external", "completed", "failed", "cancelled"]);
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;

export interface WorkflowDto {
  id: string;
  key: string;
  name: string;
  version: number;
  definition: WorkflowDefinition;
  created_at: string;
}

export interface WorkflowRunDto {
  id: string;
  workflow: { id: string; key: string; name: string; version: number };
  status: WorkflowRunStatus;
  input: string;
  current_step: string | null;
  steps: {
    key: string;
    type: WorkflowStep["type"];
    status: "pending" | "running" | "waiting_approval" | "completed" | "failed" | "skipped";
    run_id: string | null;
    approval_id: string | null;
    output: string | null;
    attempts: number;
    resume_at: string | null;
  }[];
  created_at: string;
  finished_at: string | null;
}

export const startWorkflowRunSchema = z.object({ input: z.string().trim().min(1).max(20000) }).strict();

// ---------------------------------------------------------------------------
// 組織全体のポリシー（POL-06）
// ---------------------------------------------------------------------------
export const createPolicySchema = z
  .object({ name: z.string().trim().min(1).max(100), rule: policySchema, enabled: z.boolean().default(true) })
  .strict();
export type CreatePolicyInput = z.input<typeof createPolicySchema>;

export const updatePolicySchema = z.object({ rule: policySchema.optional(), enabled: z.boolean().optional() }).strict();
export type UpdatePolicyInput = z.input<typeof updatePolicySchema>;

export interface PolicyDto {
  id: string;
  name: string;
  rule: Policy;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Eval（EVAL）
// ---------------------------------------------------------------------------
export const evalExpectationsSchema = z
  .object({
    /** 出力に含まれていなければならない文字列 */
    must_contain: z.array(z.string().min(1).max(500)).max(20).default([]),
    /** 出力に含まれてはいけない文字列 */
    must_not_contain: z.array(z.string().min(1).max(500)).max(20).default([]),
  })
  .strict();
export type EvalExpectations = z.infer<typeof evalExpectationsSchema>;

export const createEvalCaseSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    input: z.string().trim().min(1).max(20000),
    expectations: evalExpectationsSchema,
  })
  .strict();
export type CreateEvalCaseInput = z.input<typeof createEvalCaseSchema>;

export interface EvalCaseDto {
  id: string;
  agent_id: string;
  name: string;
  input: string;
  expectations: EvalExpectations;
  created_at: string;
}

export const startEvalRunSchema = z.object({ deployment_id: z.uuid() }).strict();

export interface EvalRunDto {
  id: string;
  agent_id: string;
  deployment_id: string;
  status: "running" | "passed" | "failed";
  results: {
    case_id: string;
    case_name: string;
    run_id: string | null;
    status: "pending" | "passed" | "failed";
    reasons: string[];
  }[];
  created_at: string;
  finished_at: string | null;
}

// ---------------------------------------------------------------------------
// 利用量（BILL-01）
// ---------------------------------------------------------------------------
export interface UsageDto {
  /** YYYY-MM */
  month: string;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  by_agent: { agent_id: string; agent_name: string; runs: number; input_tokens: number; output_tokens: number }[];
}

// ---------------------------------------------------------------------------
// 監査ログ
// ---------------------------------------------------------------------------
export interface AuditLogDto {
  id: string;
  actor_type: "user" | "runtime" | "system";
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  result: "success" | "failure" | "denied";
  detail: unknown;
  source_ip: string | null;
  created_at: string;
}

export const updateOrganizationSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();

export const updateWorkflowSchema = z
  .object({ name: z.string().trim().min(1).max(100), definition: workflowDefinitionSchema })
  .strict();

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.iso.datetime().optional(),
});

export { toolNameSchema };
