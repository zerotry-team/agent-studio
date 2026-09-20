import { z } from "zod";
import { memberRoleSchema, slugSchema, stageSchema, toolNameSchema, type MemberRole, type Stage } from "./common.js";
import type { AgentManifest } from "./manifest.js";
import { policySchema, type Policy } from "./policy.js";
import type { ApprovalStatus } from "./runtime-protocol.js";
import type { ToolExecutionLocation, ToolRisk, ToolVersionSpec } from "./tools.js";
import { staticHeaderNameSchema, toolVersionSpecSchema } from "./tools.js";

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
  })
  .strict();
export type SetOpenAiCredentialsInput = z.infer<typeof setOpenAiCredentialsSchema>;

export interface OpenAiSettingsDto {
  openai_project_id: string | null;
  has_app_api_key: boolean;
  has_environment_api_key: boolean;
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

export const connectorAdapterSchema = z.enum(["http_openapi", "mcp", "internal", "openai_builtin", "runtime"]);
export type ConnectorAdapter = z.infer<typeof connectorAdapterSchema>;
export const connectorAuthTypeSchema = z.enum(["none", "static_bearer", "runtime_secret"]);
export type ConnectorAuthType = z.infer<typeof connectorAuthTypeSchema>;

export const connectorOperationSchema = z
  .object({
    name: toolNameSchema,
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
  })
  .strict();
export type ConnectorOperationInput = z.input<typeof connectorOperationSchema>;

export const createConnectorSchema = z
  .object({
    key: slugSchema,
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
  .refine((v) => v.adapter !== "http_openapi" || Boolean(v.base_url), {
    message: "HTTP連携にはbase_urlが必要です",
    path: ["base_url"],
  })
  .refine((v) => v.adapter !== "http_openapi" || v.operations.every((o) => o.method && o.path), {
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
  .refine((v) => v.adapter === "http_openapi" || !v.default_headers, {
    message: "固定ヘッダはHTTP連携でだけ指定できます",
    path: ["default_headers"],
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

export interface ConnectionDto {
  id: string;
  name: string;
  description: string | null;
  connector_id: string | null;
  scope: ConnectionScope;
  runtime_id: string | null;
  runtime_secret_name: string | null;
  header_name: string | null;
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

export const createAgentProjectSchema = generateManifestSchema;
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

export const runtimeStatusSchema = z.enum(["pending", "active", "degraded", "offline", "revoked"]);
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

export interface RuntimeSummaryDto {
  id: string;
  name: string;
  stage: Stage;
  provisioning_type: ProvisioningType;
  status: RuntimeStatus;
}

export interface RuntimeDto extends RuntimeSummaryDto {
  aws_account_id: string;
  aws_region: string;
  expected_role_name: string;
  controller_version: string | null;
  last_heartbeat_at: string | null;
  registered_at: string | null;
  tools: { name: string; description: string; risk: ToolRisk; reads_untrusted_content: boolean }[];
  created_at: string;
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
  }>;
  events?: RunEventDto[];
}

/** 実行の成果物（S3 に保存したもの）。download_url は5分だけ有効 */
export interface RunArtifactDto {
  path: string;
  size_bytes: number;
  download_url: string;
}

// ---------------------------------------------------------------------------
// 承認
// ---------------------------------------------------------------------------
export const approvalDecisionSchema = z
  .object({ decision: z.enum(["approve", "deny"]), comment: z.string().max(1000).optional() })
  .strict();
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;

export interface ApprovalDto {
  id: string;
  run_id: string;
  tool: string;
  args_preview: string;
  reason: string;
  status: ApprovalStatus;
  requested_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  comment: string | null;
  agent: { id: string; name: string } | null;
}

// ---------------------------------------------------------------------------
// Workflow（WF）
// ---------------------------------------------------------------------------
export const workflowStepSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("agent"),
      key: slugSchema,
      name: z.string().trim().min(1).max(100),
      deployment_id: z.uuid(),
      /** {{input}} や {{steps.<key>.output}} を埋め込める */
      input_template: z.string().min(1).max(20000),
    })
    .strict(),
  z
    .object({
      type: z.literal("approval"),
      key: slugSchema,
      name: z.string().trim().min(1).max(100),
      message: z.string().min(1).max(2000),
    })
    .strict(),
]);
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

export const workflowDefinitionSchema = z
  .object({ steps: z.array(workflowStepSchema).min(1).max(20) })
  .strict()
  .refine((d) => new Set(d.steps.map((s) => s.key)).size === d.steps.length, {
    message: "ステップのキーが重複しています",
  });
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export const createWorkflowSchema = z
  .object({ key: slugSchema, name: z.string().trim().min(1).max(100), definition: workflowDefinitionSchema })
  .strict();
export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;

export const workflowRunStatusSchema = z.enum(["running", "waiting_approval", "completed", "failed", "cancelled"]);
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
    type: "agent" | "approval";
    status: "pending" | "running" | "waiting_approval" | "completed" | "failed" | "skipped";
    run_id: string | null;
    approval_id: string | null;
    output: string | null;
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
