import { z } from "zod";
import { memberRoleSchema, slugSchema, stageSchema, toolNameSchema, type MemberRole, type Stage } from "./common.js";
import type { AgentManifest } from "./manifest.js";
import { policySchema, type Policy } from "./policy.js";
import type { ApprovalStatus } from "./runtime-protocol.js";
import type { ToolExecutionLocation, ToolRisk, ToolVersionSpec } from "./tools.js";
import { toolVersionSpecSchema } from "./tools.js";

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
  created_at: string;
  versions?: ToolVersionDto[];
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
    /** scope=openai_vault のとき必須: この認証情報を使う MCP サーバーの URL（OpenAI の vault は URL で照合する） */
    mcp_server_url: z.url().optional(),
  })
  .strict();
export type SetConnectionSecretInput = z.infer<typeof setConnectionSecretSchema>;

export interface ConnectionDto {
  id: string;
  name: string;
  description: string | null;
  scope: ConnectionScope;
  runtime_id: string | null;
  runtime_secret_name: string | null;
  header_name: string | null;
  has_secret: boolean;
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
  latest_version: number;
  published_version: number | null;
  created_at: string;
  updated_at: string;
  versions?: AgentVersionDto[];
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
  stage: Stage;
  status: DeploymentStatus;
  created_by: string | null;
  created_at: string;
}

export const runStatusSchema = z.enum([
  "queued",
  "provisioning",
  "running",
  "waiting_approval",
  "requires_action",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

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
