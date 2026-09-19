import { z } from "zod";

/** Tool Gateway の設定（デプロイ契約 §5.3） */
const envSchema = z
  .object({
    NODE_ENV: z.string().default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    HOST: z.string().min(1).default("0.0.0.0"),
    /** Controller のハートビート用のカタログ（127.0.0.1 にだけ bind） */
    INTERNAL_PORT: z.coerce.number().int().min(1).max(65535).default(8082),

    TOOL_CONFIG_PARAMETER: z.string().min(1).optional(),
    TOOL_CONFIG_PATH: z.string().min(1).optional(),

    CONNECTION_SECRETS_SOURCE: z.enum(["secrets-manager", "env"]).default("secrets-manager"),
    CONNECTION_SECRETS_PREFIX: z.string().min(1).optional(),

    CONTROLLER_INTERNAL_URL: z.url().default("http://127.0.0.1:8081"),
    APPROVAL_WAIT_SECONDS: z.coerce.number().int().min(0).max(55).default(25),
    APPROVAL_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),
    UPSTREAM_REFRESH_SECONDS: z.coerce.number().int().min(10).max(86_400).default(300),
    UPSTREAM_IDLE_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
    AWS_REGION: z.string().min(1).default("ap-northeast-1"),
  })
  .superRefine((env, ctx) => {
    if (!env.TOOL_CONFIG_PARAMETER && !env.TOOL_CONFIG_PATH) {
      ctx.addIssue({
        code: "custom",
        path: ["TOOL_CONFIG_PARAMETER"],
        message: "TOOL_CONFIG_PARAMETER（SSM）か TOOL_CONFIG_PATH（ファイル）のどちらかが必要です",
      });
    }
    if (env.CONNECTION_SECRETS_SOURCE === "secrets-manager" && !env.CONNECTION_SECRETS_PREFIX) {
      ctx.addIssue({
        code: "custom",
        path: ["CONNECTION_SECRETS_PREFIX"],
        message: "CONNECTION_SECRETS_SOURCE=secrets-manager のときは必須です",
      });
    }
    if (env.CONNECTION_SECRETS_SOURCE === "env" && env.NODE_ENV === "production") {
      ctx.addIssue({
        code: "custom",
        path: ["CONNECTION_SECRETS_SOURCE"],
        message: "本番（NODE_ENV=production）では env は使えません",
      });
    }
  });

export interface GatewayConfig {
  nodeEnv: string;
  logLevel: string;
  host: string;
  port: number;
  internalPort: number;
  toolConfig: { parameterName?: string; path?: string };
  secrets: { source: "secrets-manager" | "env"; prefix: string };
  controllerInternalUrl: string;
  approvalWaitSeconds: number;
  approvalPollIntervalMs: number;
  upstreamRefreshMs: number;
  upstreamIdleMs: number;
  region: string;
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`設定が正しくありません:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): GatewayConfig {
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
  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    host: e.HOST,
    port: e.PORT,
    internalPort: e.INTERNAL_PORT,
    // SSM が指定されていればそちらを優先する（本番）
    toolConfig: e.TOOL_CONFIG_PARAMETER ? { parameterName: e.TOOL_CONFIG_PARAMETER } : { path: e.TOOL_CONFIG_PATH },
    secrets: { source: e.CONNECTION_SECRETS_SOURCE, prefix: e.CONNECTION_SECRETS_PREFIX ?? "" },
    controllerInternalUrl: e.CONTROLLER_INTERNAL_URL.replace(/\/+$/, ""),
    approvalWaitSeconds: e.APPROVAL_WAIT_SECONDS,
    approvalPollIntervalMs: e.APPROVAL_POLL_INTERVAL_MS,
    upstreamRefreshMs: e.UPSTREAM_REFRESH_SECONDS * 1000,
    upstreamIdleMs: e.UPSTREAM_IDLE_MINUTES * 60_000,
    region: e.AWS_REGION,
  };
}
