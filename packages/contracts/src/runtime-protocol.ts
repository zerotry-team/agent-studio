import { z } from "zod";
import { toolNameSchema } from "./common.js";
import { policySchema } from "./policy.js";
import { runtimeToolDeliverySchema } from "./runtime-config.js";
import { inputSchemaSchema, toolRiskSchema } from "./tools.js";

/**
 * Agent Studio（Control Plane）と Runtime Controller（Execution Plane）の間のプロトコル。
 * 通信は常に Runtime → Agent Studio のアウトバウンド HTTPS（RTM-05 / CRT-07）。
 */
export const RUNTIME_PROTOCOL_VERSION = 1 as const;

/** 署名済み GetCallerIdentity に必ず含める、Agent Studio 固有のヘッダ（SEC-15） */
export const RUNTIME_SERVER_ID_HEADER = "x-agent-studio-server-id";

/** STS に送る本文（固定） */
export const STS_GET_CALLER_IDENTITY_BODY = "Action=GetCallerIdentity&Version=2011-06-15";

/**
 * ローカル開発用の身元（Agent Studio 側が RUNTIME_IDENTITY_MODE=dev のときだけ受け付ける）。
 * url は dev://<12桁のアカウントID>/<ロール名>
 */
export const DEV_IDENTITY_PROTOCOL = "dev:";

/**
 * Runtime が自分の IAM ロールで SigV4 署名した sts:GetCallerIdentity リクエスト。
 * Agent Studio はこれを STS にそのまま転送し、呼び出し元の ARN を得る（SEC-05）。
 */
export const signedIdentitySchema = z
  .object({
    method: z.literal("POST"),
    url: z.url(),
    headers: z.record(z.string(), z.string()),
    /** base64 */
    body: z.string().max(4096),
  })
  .strict();
export type SignedIdentity = z.infer<typeof signedIdentitySchema>;

export const registerRequestSchema = z
  .object({
    bootstrap_token: z.string().min(32).max(256),
    identity: signedIdentitySchema,
    controller_version: z.string().min(1).max(64),
  })
  .strict();
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const registerResponseSchema = z.object({
  runtime_id: z.uuid(),
  organization_id: z.uuid(),
  stage: z.enum(["staging", "production"]),
  access_token: z.string(),
  expires_in: z.number().int(),
  /** OpenAI の環境キー（Runtime の Secrets Manager に保存する） */
  environment_key: z.string().nullable(),
});
export type RegisterResponse = z.infer<typeof registerResponseSchema>;

export const tokenRequestSchema = z.object({ identity: signedIdentitySchema }).strict();
export type TokenRequest = z.infer<typeof tokenRequestSchema>;

export const tokenResponseSchema = z.object({
  runtime_id: z.uuid(),
  organization_id: z.uuid(),
  access_token: z.string(),
  expires_in: z.number().int(),
});
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

/** Runtime 側の Tool Gateway が提供できるツール（Agent Studio に報告する） */
export const runtimeToolCatalogEntrySchema = z.object({
  name: toolNameSchema,
  description: z.string().max(1000),
  input_schema: inputSchemaSchema,
  risk: toolRiskSchema,
  reads_untrusted_content: z.boolean(),
  delivery: runtimeToolDeliverySchema.optional(),
});
export type RuntimeToolCatalogEntry = z.infer<typeof runtimeToolCatalogEntrySchema>;

export const browserModeSchema = z.enum(["public_ephemeral", "authenticated_restricted"]);
export type BrowserMode = z.infer<typeof browserModeSchema>;

export const browserViewportSchema = z
  .object({
    width: z.number().int().min(320).max(3840).default(1440),
    height: z.number().int().min(240).max(2160).default(900),
  })
  .strict();

/** Control Plane から Runtime Controller へ渡す Browser Session の起動設定。 */
export const browserSessionConfigSchema = z
  .object({
    enabled: z.boolean(),
    mode: browserModeSchema,
    profile_id: z.uuid().optional(),
    /** 公開Webサイト全般を許可する。IP 直指定と private アドレスは、この場合も常に拒否する */
    allow_public_web: z.boolean().default(false),
    allowed_domains: z.array(z.string().min(1).max(253)).max(100),
    code_execution_enabled: z.boolean(),
    computer_actions_enabled: z.boolean(),
    viewport: browserViewportSchema,
  })
  .strict()
  .superRefine((browser, ctx) => {
    if (browser.mode === "authenticated_restricted" && browser.code_execution_enabled) {
      ctx.addIssue({ code: "custom", path: ["code_execution_enabled"], message: "認証済み Browser ではコード実行を有効にできません" });
    }
    if (browser.mode === "authenticated_restricted" && !browser.profile_id) {
      ctx.addIssue({ code: "custom", path: ["profile_id"], message: "認証済み Browser には profile_id が必要です" });
    }
  });
export type BrowserSessionConfig = z.infer<typeof browserSessionConfigSchema>;

/** Controller が起動後に解決し、Tool Gateway だけへ返す接続情報。 */
export const browserSessionGrantSchema = z
  .object({
    endpoint: z.url().refine((url) => /^https?:\/\//.test(url), "Browser endpoint は http または https にしてください"),
    mode: browserModeSchema,
    allow_public_web: z.boolean().default(false),
    allowed_domains: z.array(z.string().min(1).max(253)).max(100),
  })
  .strict();
export type BrowserSessionGrant = z.infer<typeof browserSessionGrantSchema>;

export const heartbeatRequestSchema = z
  .object({
    controller_version: z.string().min(1).max(64),
    /** Session Worker から見た Tool Gateway の MCP エンドポイント（Agent 設定の MCP の URL に使う） */
    gateway_url: z.url().max(500),
    active_sessions: z.array(z.uuid()).max(1000),
    tools: z.array(runtimeToolCatalogEntrySchema).max(500),
    /** Controller 自身が実行できる管理能力。業務 Tool Catalog とは分離する。 */
    capabilities: z.array(z.enum(["builder_workspace", "adapter_delivery"])).max(20).optional(),
  })
  .strict();
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

/** Tool Gateway がツール呼び出しを認可するための情報 */
export const sessionGrantSchema = z.object({
  session_id: z.uuid(),
  run_id: z.uuid(),
  /** Session Worker が Tool Gateway に提示するトークンの SHA-256。平文は Agent Studio も保存しない */
  token_hash: z.string().regex(/^[0-9a-f]{64}$/),
  allowed_tools: z.array(toolNameSchema).max(200),
  policies: z.array(policySchema).max(200),
  expires_at: z.iso.datetime(),
  browser: browserSessionGrantSchema.optional(),
});
export type SessionGrant = z.infer<typeof sessionGrantSchema>;

/** start_sessionでexec-serverを起動する前に、モデルへ資格情報を見せず準備するBuilder workspace。 */
export const builderSessionWorkspaceSchema = z.object({
  project_id: z.uuid(),
  change_set_id: z.uuid(),
  capability_topic: z.string().min(1).max(128),
  repository_url: z.url().max(1000).refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  }),
  base_branch: z.string().min(1).max(200).regex(/^[A-Za-z0-9._/-]+$/)
    .refine((value) => !value.startsWith("/") && !value.endsWith("/") && !value.includes("//") && !value.includes("..")),
  branch: z.string().min(1).max(200).regex(/^[A-Za-z0-9._/-]+$/)
    .refine((value) => !value.startsWith("/") && !value.endsWith("/") && !value.includes("//") && !value.includes("..")),
  adapter_path: z.string().min(1).max(500)
    .refine((value) => !value.startsWith("/") && !value.endsWith("/") && value.split("/").every((part) => Boolean(part) && part !== "." && part !== "..")),
}).strict();
export type BuilderSessionWorkspace = z.infer<typeof builderSessionWorkspaceSchema>;

export const startSessionJobSchema = z.object({
  type: z.literal("start_session"),
  job_id: z.uuid(),
  session: sessionGrantSchema.omit({ browser: true }).extend({
    openai_session_id: z.string().min(1),
    environment_id: z.string().min(1),
    remote_url: z.string().min(1),
    max_lifetime_minutes: z.number().int().min(1).max(1440),
    idle_timeout_minutes: z.number().int().min(1).max(1440),
    browser: browserSessionConfigSchema.optional(),
    builder_workspace: builderSessionWorkspaceSchema.optional(),
  }),
});

export const stopSessionJobSchema = z.object({
  type: z.literal("stop_session"),
  job_id: z.uuid(),
  session_id: z.uuid(),
  reason: z.string().max(500),
});

export const rotateEnvironmentKeyJobSchema = z.object({
  type: z.literal("rotate_environment_key"),
  job_id: z.uuid(),
});

const gitRefSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._/-]+$/)
  .refine((value) => !value.startsWith("/") && !value.endsWith("/") && !value.includes("//") && !value.includes(".."));

const repositoryPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !value.startsWith("/") && !value.endsWith("/") && value.split("/").every((part) => Boolean(part) && part !== "." && part !== ".."));

/** Builderが顧客Runtime内の隔離コンテナへ渡す、非機微なCode Workspace入力。 */
export const builderWorkspaceJobSchema = z.object({
  type: z.literal("builder_workspace"),
  job_id: z.uuid(),
  project_id: z.uuid(),
  change_set_id: z.uuid(),
  capability_topic: z.string().min(1).max(128),
  repository_url: z.url().max(1000).refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  }),
  base_branch: gitRefSchema,
  branch: gitRefSchema,
  adapter_path: repositoryPathSchema,
  interface_notes: z.string().min(1).max(4000),
});
export type BuilderWorkspaceJob = z.infer<typeof builderWorkspaceJobSchema>;

/** token本体を含めず、Runtimeが実行直前に一度だけ資格情報を取得するbranch pushジョブ。 */
export const publishBuilderBranchJobSchema = z.object({
  type: z.literal("publish_builder_branch"),
  job_id: z.uuid(),
  project_id: z.uuid(),
  change_set_id: z.uuid(),
  connection_id: z.uuid(),
  repository_url: z.url().refine((value) => value.startsWith("https://github.com/") && !new URL(value).username),
  base_branch: gitRefSchema,
  branch: gitRefSchema.refine((value) => value.startsWith("builder/"), "Builder専用branchだけを使用できます"),
  base_sha: z.string().regex(/^[0-9a-f]{40,64}$/),
  commit_sha: z.string().regex(/^[0-9a-f]{40,64}$/),
}).strict();
export type PublishBuilderBranchJob = z.infer<typeof publishBuilderBranchJobSchema>;

export const startBrowserLoginJobSchema = z.object({
  type: z.literal("start_browser_login"),
  job_id: z.uuid(),
  login_session_id: z.uuid(),
  profile_id: z.uuid(),
  provider_key: z.string().min(1).max(100),
  allowed_domains: z.array(z.string().min(1).max(253)).min(1).max(20),
  expires_at: z.iso.datetime(),
}).strict();
export type StartBrowserLoginJob = z.infer<typeof startBrowserLoginJobSchema>;

export const browserLoginResultSchema = z.object({
  login_session_id: z.uuid(),
  profile_id: z.uuid(),
  runtime_object_key: z.string().min(1).max(1000),
  verified_domains: z.array(z.string().min(1).max(253)).min(1).max(20),
  expires_at: z.iso.datetime(),
}).strict();
export type BrowserLoginResult = z.infer<typeof browserLoginResultSchema>;

/** RuntimeがProfile本文を顧客Storeから復元するための、Control Plane側メタデータだけの応答。 */
export const runtimeBrowserProfileSchema = z.object({
  profile_id: z.uuid(),
  runtime_object_key: z.string().min(1).max(1000),
  allowed_domains: z.array(z.string().min(1).max(253)).min(1).max(20),
  expires_at: z.iso.datetime(),
}).strict();
export type RuntimeBrowserProfile = z.infer<typeof runtimeBrowserProfileSchema>;

export const revokeBrowserProfileJobSchema = z.object({
  type: z.literal("revoke_browser_profile"),
  job_id: z.uuid(),
  profile_id: z.uuid(),
  runtime_object_key: z.string().min(1).max(1000),
}).strict();
export type RevokeBrowserProfileJob = z.infer<typeof revokeBrowserProfileJobSchema>;

export const gitCredentialResponseSchema = z.object({
  username: z.literal("x-access-token"),
  token: z.string().min(20),
  expires_at: z.iso.datetime(),
  repository_url: z.url(),
}).strict();
export type GitCredentialResponse = z.infer<typeof gitCredentialResponseSchema>;

const builderWorkspaceTestResultSchema = z.object({
  command: z.string().min(1).max(500),
  status: z.enum(["passed", "failed"]),
  exit_code: z.number().int().min(0).max(255),
});

/** Code WorkspaceからControl Planeへ戻してよい、Secretやソース本文を含まない証跡。 */
export const builderWorkspaceResultSchema = z.object({
  change_set_id: z.uuid(),
  commit_sha: z.string().regex(/^[0-9a-f]{40,64}$/),
  diff_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  summary: z.string().min(1).max(1000),
  changed_files: z.array(repositoryPathSchema).min(1).max(200),
  tests: z.array(builderWorkspaceTestResultSchema).min(1).max(50),
});
export type BuilderWorkspaceResult = z.infer<typeof builderWorkspaceResultSchema>;

/** Agents API Artifactとして返すBuilder結果。開始時に固定したbase SHAも照合する。 */
export const builderSessionResultSchema = builderWorkspaceResultSchema.extend({
  base_sha: z.string().regex(/^[0-9a-f]{40,64}$/),
});
export type BuilderSessionResult = z.infer<typeof builderSessionResultSchema>;

/** Self-hosted Session Workerの隔離volumeから、検証済み結果だけを回収する。 */
export const collectBuilderSessionResultJobSchema = z.object({
  type: z.literal("collect_builder_session_result"),
  job_id: z.uuid(),
  session_id: z.uuid(),
  change_set_id: z.uuid(),
}).strict();
export type CollectBuilderSessionResultJob = z.infer<typeof collectBuilderSessionResultJobSchema>;

export const gitPublishResultSchema = z.object({
  change_set_id: z.uuid(),
  branch: gitRefSchema,
  base_sha: z.string().regex(/^[0-9a-f]{40,64}$/),
  head_sha: z.string().regex(/^[0-9a-f]{40,64}$/),
  remote_ref: z.string().startsWith("refs/heads/builder/").max(300),
}).strict();
export type GitPublishResult = z.infer<typeof gitPublishResultSchema>;

export const runtimeJobSchema = z.discriminatedUnion("type", [
  startSessionJobSchema,
  stopSessionJobSchema,
  rotateEnvironmentKeyJobSchema,
  builderWorkspaceJobSchema,
  collectBuilderSessionResultJobSchema,
  publishBuilderBranchJobSchema,
  startBrowserLoginJobSchema,
  revokeBrowserProfileJobSchema,
]);
export type RuntimeJob = z.infer<typeof runtimeJobSchema>;
export type StartSessionJob = z.infer<typeof startSessionJobSchema>;

export const nextJobResponseSchema = z.object({ job: runtimeJobSchema.nullable() });

export const jobResultRequestSchema = z
  .object({
    status: z.enum(["succeeded", "failed"]),
    error: z.string().max(2000).optional(),
    // builderSessionResultはbuilderWorkspaceResultの上位互換なので先に評価し、
    // base_shaがstripされないようにする。
    output: z.union([browserLoginResultSchema, builderSessionResultSchema, builderWorkspaceResultSchema, gitPublishResultSchema]).optional(),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.status === "failed" && result.output) {
      ctx.addIssue({ code: "custom", path: ["output"], message: "失敗したジョブへ成功結果は付けられません" });
    }
  });
export type JobResultRequest = z.infer<typeof jobResultRequestSchema>;

export const workerEventTypeSchema = z.enum(["worker_starting", "worker_running", "worker_stopped", "worker_failed"]);
export const sessionEventRequestSchema = z
  .object({
    type: workerEventTypeSchema,
    task_arn: z.string().max(512).optional(),
    detail: z.string().max(2000).optional(),
  })
  .strict();
export type SessionEventRequest = z.infer<typeof sessionEventRequestSchema>;

export const activeSessionsResponseSchema = z.object({ sessions: z.array(sessionGrantSchema) });

export const approvalRequestSchema = z
  .object({
    session_id: z.uuid(),
    tool: toolNameSchema,
    args_hash: z.string().regex(/^[0-9a-f]{64}$/),
    /** 承認者に見せる引数（Tool Gateway 側で長さを制限したもの） */
    args_preview: z.string().max(4000),
    reason: z.string().max(1000),
    timeout_minutes: z.number().int().min(1).max(10080),
    /** 自動承認Policyの実行直前評価に使う。古いRuntimeとの互換のため省略可だが、省略時はfail closed。 */
    risk: z.enum(["read", "write", "external_send", "financial", "destructive"]).optional(),
    destination_host: z.string().trim().min(1).max(253).optional(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
    requested_records: z.number().int().nonnegative().max(100_000).optional(),
  })
  .strict();
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const approvalStatusSchema = z.enum(["pending", "approved", "denied", "expired", "consumed"]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const approvalResponseSchema = z.object({
  approval_id: z.uuid(),
  status: approvalStatusSchema,
});
export type ApprovalResponse = z.infer<typeof approvalResponseSchema>;

/** Browser Downloadなど、Runtime内で取得したファイルの本文上限（base64前） */
export const SESSION_ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;

const artifactBodyFields = {
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size_bytes: z.number().int().nonnegative().max(SESSION_ARTIFACT_MAX_BYTES),
  content_base64: z.string().max(Math.ceil(SESSION_ARTIFACT_MAX_BYTES / 3) * 4 + 4),
};

/** Session Workerが回収する作業領域のディレクトリ（/workspace からの相対） */
export const SESSION_OUTPUT_DIRECTORIES = ["outputs", "generated_images"] as const;

/** /workspace からの相対パス。回収対象のディレクトリ配下だけを受け付け、親ディレクトリ参照を拒否する */
export const sessionOutputPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => {
    const parts = value.split("/");
    return (SESSION_OUTPUT_DIRECTORIES as readonly string[]).includes(parts[0] ?? "")
      && parts.length >= 2
      && parts.every((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith(".") && !/[\\\0\r\n]/.test(part));
  }, "回収できないパスです");

/**
 * Runtime内で取得したファイルをRun Artifactとして保存する（Tool Gateway → Controller → Agent Studio）。
 * 本文はモデルへ返さず、保存後のメタデータだけをTool結果に載せる。
 */
export const sessionArtifactRequestSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("browser_download"),
      /** Browser Worker内のArtifact ID。Upload時にも同じIDを使う */
      source_artifact_id: z.uuid(),
      filename: z.string().min(1).max(255).refine((value) => !/[\\/\0\r\n]/.test(value) && value !== "." && value !== "..", "ファイル名が不正です"),
      mime_type: z.string().min(1).max(200),
      ...artifactBodyFields,
    })
    .strict(),
  z
    .object({
      /** Session Workerの /workspace/outputs などに置かれたファイル */
      source: z.literal("session_output"),
      path: sessionOutputPathSchema,
      ...artifactBodyFields,
    })
    .strict(),
]);
export type SessionArtifactRequest = z.infer<typeof sessionArtifactRequestSchema>;

export const sessionArtifactResponseSchema = z.object({
  run_artifact_id: z.uuid(),
  path: z.string(),
  scan_status: z.enum(["passed", "rejected"]),
  retained_until: z.iso.datetime(),
});
export type SessionArtifactResponse = z.infer<typeof sessionArtifactResponseSchema>;

export const toolAuditEventSchema = z.object({
  session_id: z.uuid(),
  tool: z.string().max(128),
  args_hash: z.string().max(64),
  decision: z.enum(["allowed", "denied", "approval_required", "executed", "failed"]),
  detail: z.string().max(1000).optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  at: z.iso.datetime(),
});
export type ToolAuditEvent = z.infer<typeof toolAuditEventSchema>;

export const auditBatchRequestSchema = z.object({ events: z.array(toolAuditEventSchema).min(1).max(500) }).strict();

export const environmentKeyResponseSchema = z.object({ environment_key: z.string().nullable() });

/** Runtime API のパス（Agent Studio 側のルート定義と Runtime Controller のクライアントで共有） */
export const RUNTIME_API = {
  register: "/runtime/v1/register",
  token: "/runtime/v1/token",
  heartbeat: "/runtime/v1/heartbeat",
  nextJob: "/runtime/v1/jobs/next",
  jobResult: (jobId: string) => `/runtime/v1/jobs/${jobId}/result`,
  sessionEvent: (sessionId: string) => `/runtime/v1/sessions/${sessionId}/events`,
  activeSessions: "/runtime/v1/sessions/active",
  approvals: "/runtime/v1/approvals",
  approval: (approvalId: string) => `/runtime/v1/approvals/${approvalId}`,
  consumeApproval: (approvalId: string) => `/runtime/v1/approvals/${approvalId}/consume`,
  audit: "/runtime/v1/audit",
  environmentKey: "/runtime/v1/environment-key",
  gitCredential: (jobId: string) => `/runtime/v1/jobs/${jobId}/git-credential`,
  browserProfile: (profileId: string) => `/runtime/v1/browser-profiles/${profileId}`,
  sessionArtifacts: (sessionId: string) => `/runtime/v1/sessions/${sessionId}/artifacts`,
} as const;
