import { z } from "zod";

/**
 * Runtime Controller の設定（デプロイ契約 §5.3）。
 * 起動時に検証し、足りない・誤っている値があれば起動しない。
 */

const csv = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string()).min(1));

const httpUrl = z.url().refine((u) => /^https?:\/\//.test(u), "http または https の URL を指定してください");

const envSchema = z
  .object({
    NODE_ENV: z.string().default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

    AGENT_STUDIO_URL: httpUrl,
    RUNTIME_SERVER_ID: z.string().min(1).max(128),
    AWS_REGION: z.string().min(1).default("ap-northeast-1"),

    // 身元証明: aws = SigV4 署名済み GetCallerIdentity、dev = ローカル開発用
    RUNTIME_IDENTITY_MODE: z.enum(["aws", "dev"]).default("aws"),
    DEV_AWS_ACCOUNT_ID: z.string().regex(/^\d{12}$/, "12 桁の数字で指定してください").optional(),
    DEV_ROLE_NAME: z.string().regex(/^[\w+=,.@-]{1,64}$/).optional(),

    ENVIRONMENT_KEY_STORE: z.enum(["secrets-manager", "memory"]).default("secrets-manager"),
    BOOTSTRAP_TOKEN_SECRET_ID: z.string().min(1).optional(),
    ENVIRONMENT_KEY_SECRET_ID: z.string().min(1).optional(),
    /** ローカル開発用: シークレットの代わりに環境変数で Bootstrap Token を渡す */
    BOOTSTRAP_TOKEN: z.string().optional(),

    SESSION_LAUNCHER: z.enum(["ecs", "docker", "noop"]).default("ecs"),
    ECS_CLUSTER: z.string().min(1).optional(),
    SESSION_WORKER_TASK_DEFINITION: z.string().min(1).optional(),
    SESSION_WORKER_SUBNETS: csv.optional(),
    SESSION_WORKER_SECURITY_GROUPS: csv.optional(),
    SESSION_WORKER_CONTAINER_NAME: z.string().min(1).default("session-worker"),
    /** SESSION_LAUNCHER=docker のときのイメージ */
    SESSION_WORKER_IMAGE: z.string().min(1).optional(),
    SESSION_WORKER_DOCKER_NETWORK: z.string().min(1).optional(),

    BROWSER_LAUNCHER: z.enum(["ecs", "docker", "noop", "disabled"]).default("disabled"),
    BROWSER_WORKER_TASK_DEFINITION: z.string().min(1).optional(),
    BROWSER_WORKER_SUBNETS: csv.optional(),
    BROWSER_WORKER_SECURITY_GROUPS: csv.optional(),
    BROWSER_WORKER_CONTAINER_NAME: z.string().min(1).default("browser-session-worker"),
    BROWSER_WORKER_IMAGE: z.string().min(1).optional(),
    BROWSER_WORKER_DOCKER_NETWORK: z.string().min(1).optional(),
    BROWSER_PROFILE_STORE: z.enum(["s3", "filesystem", "disabled"]).default("disabled"),
    BROWSER_PROFILE_BUCKET: z.string().min(3).max(255).optional(),
    BROWSER_PROFILE_KMS_KEY_ARN: z.string().min(20).optional(),
    BROWSER_PROFILE_DIRECTORY: z.string().min(1).default("/tmp/agent-studio-browser-profiles"),

    BUILDER_WORKSPACE_EXECUTOR: z.enum(["disabled", "docker"]).default("disabled"),
    BUILDER_WORKSPACE_IMAGE: z.string().min(1).optional(),
    BUILDER_WORKSPACE_DOCKER_NETWORK: z.string().min(1).optional(),
    BUILDER_WORKSPACE_TIMEOUT_MINUTES: z.coerce.number().int().min(5).max(120).default(30),

    GATEWAY_PUBLIC_URL: httpUrl,
    GATEWAY_CATALOG_URL: httpUrl.default("http://127.0.0.1:8082/internal/catalog"),
    CONTROLLER_INTERNAL_PORT: z.coerce.number().int().min(1).max(65535).default(8081),

    MAX_CONCURRENT_SESSIONS: z.coerce.number().int().min(1).max(1000).default(10),
    SESSION_MAX_LIFETIME_MINUTES: z.coerce.number().int().min(1).max(1440).default(120),
    SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  })
  .superRefine((env, ctx) => {
    const need = (key: keyof typeof env, when: string) => {
      if (env[key] === undefined) ctx.addIssue({ code: "custom", path: [key], message: `${when} のときは必須です` });
    };
    if (env.RUNTIME_IDENTITY_MODE === "dev") {
      need("DEV_AWS_ACCOUNT_ID", "RUNTIME_IDENTITY_MODE=dev");
      need("DEV_ROLE_NAME", "RUNTIME_IDENTITY_MODE=dev");
      if (env.NODE_ENV === "production") {
        ctx.addIssue({ code: "custom", path: ["RUNTIME_IDENTITY_MODE"], message: "本番（NODE_ENV=production）では dev は使えません" });
      }
    }
    if (env.ENVIRONMENT_KEY_STORE === "secrets-manager") {
      need("BOOTSTRAP_TOKEN_SECRET_ID", "ENVIRONMENT_KEY_STORE=secrets-manager");
      need("ENVIRONMENT_KEY_SECRET_ID", "ENVIRONMENT_KEY_STORE=secrets-manager");
    }
    if (env.SESSION_LAUNCHER === "ecs") {
      need("ECS_CLUSTER", "SESSION_LAUNCHER=ecs");
      need("SESSION_WORKER_TASK_DEFINITION", "SESSION_LAUNCHER=ecs");
      need("SESSION_WORKER_SUBNETS", "SESSION_LAUNCHER=ecs");
      need("SESSION_WORKER_SECURITY_GROUPS", "SESSION_LAUNCHER=ecs");
    }
    if (env.SESSION_LAUNCHER === "docker") need("SESSION_WORKER_IMAGE", "SESSION_LAUNCHER=docker");
    if (env.BROWSER_LAUNCHER === "ecs") {
      need("ECS_CLUSTER", "BROWSER_LAUNCHER=ecs");
      need("BROWSER_WORKER_TASK_DEFINITION", "BROWSER_LAUNCHER=ecs");
      need("BROWSER_WORKER_SUBNETS", "BROWSER_LAUNCHER=ecs");
      need("BROWSER_WORKER_SECURITY_GROUPS", "BROWSER_LAUNCHER=ecs");
    }
    if (env.BROWSER_LAUNCHER === "docker") need("BROWSER_WORKER_IMAGE", "BROWSER_LAUNCHER=docker");
    if (env.BROWSER_PROFILE_STORE === "s3") {
      need("BROWSER_PROFILE_BUCKET", "BROWSER_PROFILE_STORE=s3");
      need("BROWSER_PROFILE_KMS_KEY_ARN", "BROWSER_PROFILE_STORE=s3");
    }
    if (env.NODE_ENV === "production" && env.BROWSER_LAUNCHER !== "disabled" && env.BROWSER_PROFILE_STORE !== "s3") {
      ctx.addIssue({ code: "custom", path: ["BROWSER_PROFILE_STORE"], message: "本番のBrowser ProfileはS3 SSE-KMSへ保存してください" });
    }
    if (env.BUILDER_WORKSPACE_EXECUTOR === "docker") need("BUILDER_WORKSPACE_IMAGE", "BUILDER_WORKSPACE_EXECUTOR=docker");
  });

export type LauncherConfig =
  | {
      type: "ecs";
      cluster: string;
      taskDefinition: string;
      subnets: string[];
      securityGroups: string[];
      containerName: string;
    }
  | { type: "docker"; image: string; network?: string }
  | { type: "noop" };

export type BrowserLauncherConfig =
  | {
      type: "ecs";
      cluster: string;
      taskDefinition: string;
      subnets: string[];
      securityGroups: string[];
      containerName: string;
    }
  | { type: "docker"; image: string; network?: string }
  | { type: "noop" }
  | { type: "disabled" };

export type WorkspaceExecutorConfig =
  | { type: "disabled" }
  | { type: "docker"; image: string; network?: string; timeoutMinutes: number };

export interface ControllerConfig {
  nodeEnv: string;
  logLevel: string;
  agentStudioUrl: string;
  runtimeServerId: string;
  region: string;
  identity: { mode: "aws" } | { mode: "dev"; accountId: string; roleName: string };
  secrets: {
    store: "secrets-manager" | "memory";
    bootstrapTokenSecretId: string;
    environmentKeySecretId: string;
    bootstrapTokenOverride?: string;
  };
  launcher: LauncherConfig;
  browserLauncher: BrowserLauncherConfig;
  browserProfileStore:
    | { type: "s3"; bucket: string; kmsKeyArn: string }
    | { type: "filesystem"; directory: string }
    | { type: "disabled" };
  workspaceExecutor: WorkspaceExecutorConfig;
  gatewayPublicUrl: string;
  gatewayCatalogUrl: string;
  internalPort: number;
  maxConcurrentSessions: number;
  sessionMaxLifetimeMinutes: number;
  sessionIdleTimeoutMinutes: number;
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`設定が正しくありません:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): ControllerConfig {
  // 空文字は未設定として扱う（Terraform やシェルで空のまま渡されることがあるため）
  const env = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => {
        const missing = i.code === "invalid_type" && /received undefined/.test(i.message);
        return `${i.path.join(".") || "(env)"}: ${missing ? "必須です" : i.message}`;
      }),
    );
  }
  const e = parsed.data;

  let launcher: LauncherConfig;
  if (e.SESSION_LAUNCHER === "ecs") {
    launcher = {
      type: "ecs",
      cluster: e.ECS_CLUSTER!,
      taskDefinition: e.SESSION_WORKER_TASK_DEFINITION!,
      subnets: e.SESSION_WORKER_SUBNETS!,
      securityGroups: e.SESSION_WORKER_SECURITY_GROUPS!,
      containerName: e.SESSION_WORKER_CONTAINER_NAME,
    };
  } else if (e.SESSION_LAUNCHER === "docker") {
    launcher = { type: "docker", image: e.SESSION_WORKER_IMAGE!, network: e.SESSION_WORKER_DOCKER_NETWORK };
  } else {
    launcher = { type: "noop" };
  }

  let browserLauncher: BrowserLauncherConfig;
  if (e.BROWSER_LAUNCHER === "ecs") {
    browserLauncher = {
      type: "ecs",
      cluster: e.ECS_CLUSTER!,
      taskDefinition: e.BROWSER_WORKER_TASK_DEFINITION!,
      subnets: e.BROWSER_WORKER_SUBNETS!,
      securityGroups: e.BROWSER_WORKER_SECURITY_GROUPS!,
      containerName: e.BROWSER_WORKER_CONTAINER_NAME,
    };
  } else if (e.BROWSER_LAUNCHER === "docker") {
    browserLauncher = { type: "docker", image: e.BROWSER_WORKER_IMAGE!, network: e.BROWSER_WORKER_DOCKER_NETWORK };
  } else {
    browserLauncher = { type: e.BROWSER_LAUNCHER };
  }

  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    agentStudioUrl: e.AGENT_STUDIO_URL.replace(/\/+$/, ""),
    runtimeServerId: e.RUNTIME_SERVER_ID,
    region: e.AWS_REGION,
    identity:
      e.RUNTIME_IDENTITY_MODE === "dev"
        ? { mode: "dev", accountId: e.DEV_AWS_ACCOUNT_ID!, roleName: e.DEV_ROLE_NAME! }
        : { mode: "aws" },
    secrets: {
      store: e.ENVIRONMENT_KEY_STORE,
      bootstrapTokenSecretId: e.BOOTSTRAP_TOKEN_SECRET_ID ?? "local/bootstrap-token",
      environmentKeySecretId: e.ENVIRONMENT_KEY_SECRET_ID ?? "local/openai-environment-key",
      bootstrapTokenOverride: e.BOOTSTRAP_TOKEN,
    },
    launcher,
    browserLauncher,
    browserProfileStore: e.BROWSER_PROFILE_STORE === "s3"
      ? { type: "s3", bucket: e.BROWSER_PROFILE_BUCKET!, kmsKeyArn: e.BROWSER_PROFILE_KMS_KEY_ARN! }
      : e.BROWSER_PROFILE_STORE === "filesystem"
        ? { type: "filesystem", directory: e.BROWSER_PROFILE_DIRECTORY }
        : { type: "disabled" },
    workspaceExecutor: e.BUILDER_WORKSPACE_EXECUTOR === "docker"
      ? {
          type: "docker",
          image: e.BUILDER_WORKSPACE_IMAGE!,
          network: e.BUILDER_WORKSPACE_DOCKER_NETWORK,
          timeoutMinutes: e.BUILDER_WORKSPACE_TIMEOUT_MINUTES,
        }
      : { type: "disabled" },
    gatewayPublicUrl: e.GATEWAY_PUBLIC_URL,
    gatewayCatalogUrl: e.GATEWAY_CATALOG_URL,
    internalPort: e.CONTROLLER_INTERNAL_PORT,
    maxConcurrentSessions: e.MAX_CONCURRENT_SESSIONS,
    sessionMaxLifetimeMinutes: e.SESSION_MAX_LIFETIME_MINUTES,
    sessionIdleTimeoutMinutes: e.SESSION_IDLE_TIMEOUT_MINUTES,
  };
}
