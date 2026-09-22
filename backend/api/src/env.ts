import { hostname } from "node:os";
import { z } from "zod";

const isProduction = process.env.NODE_ENV === "production";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_ENV: z.string().default("local"),
    PORT: z.coerce.number().int().default(3200),
    PUBLIC_BASE_URL: z.string().default("http://localhost:3201"),
    PUBLIC_API_BASE_URL: z.string().default("http://localhost:3200"),
    LOG_LEVEL: z.string().default("info"),

    // DB: DATABASE_URL か、DB_* の組み合わせ（ECS ではこちら）
    DATABASE_URL: z.string().optional(),
    DB_HOST: z.string().optional(),
    DB_PORT: z.coerce.number().int().default(5432),
    DB_NAME: z.string().default("agent_studio"),
    DB_APP_USER: z.string().default("agent_studio_app"),
    DB_APP_PASSWORD: z.string().optional(),
    DB_POOL_MAX: z.coerce.number().int().default(10),
    DB_SSL_CA_PATH: z.string().default("/etc/ssl/certs/rds-global-bundle.pem"),

    // 利用者の認証
    AUTH_MODE: z.enum(["cognito", "dev"]).default(isProduction ? "cognito" : "dev"),
    COGNITO_USER_POOL_ID: z.string().optional(),
    COGNITO_CLIENT_ID: z.string().optional(),

    // Runtime の認証
    RUNTIME_TOKEN_SECRET: z.string().min(32).optional(),
    RUNTIME_SERVER_ID: z.string().default("agent-studio-local"),
    RUNTIME_IDENTITY_MODE: z.enum(["aws", "dev"]).default("aws"),

    // シークレットの保管
    SECRETS_MODE: z.enum(["aws", "file", "memory"]).default(isProduction ? "aws" : "file"),
    SECRETS_PREFIX: z.string().default("agent-studio/local"),
    /** SECRETS_MODE=file のときの保存先（ローカル開発用。API と Worker で同じパスにする） */
    SECRETS_FILE: z.string().default(".secrets.local.json"),
    SECRETS_KMS_KEY_ID: z.string().optional(),
    AWS_REGION: z.string().default("ap-northeast-1"),

    ARTIFACTS_BUCKET: z.string().optional(),
    AUDIT_EXPORT_BUCKET: z.string().optional(),

    // Agent Studio管理のAWS Runtimeを自動構築するWorker設定。
    // role が空なら機能を無効にし、画面/APIは作成要求を受け付けない。
    MANAGED_RUNTIME_PROVISIONING_ROLE_ARN: z.string().regex(/^arn:aws:iam::\d{12}:role\/.+$/).optional(),
    MANAGED_RUNTIME_STATE_BUCKET: z.string().optional(),
    MANAGED_RUNTIME_ACCOUNT_EMAIL_DOMAIN: z.string().regex(/^[A-Za-z0-9.-]+$/).default("zerotry.dev"),
    MANAGED_RUNTIME_IMAGE_REGISTRY: z.string().optional(),
    MANAGED_RUNTIME_IMAGE_TAG: z.string().optional(),
    MANAGED_RUNTIME_TERRAFORM_ROOT: z.string().default("/app/infra/managed-runtime"),
    MANAGED_RUNTIME_MAX_CONCURRENT: z.coerce.number().int().min(1).max(5).default(1),

    // OpenAI Agents API
    AGENTS_API_MODE: z.enum(["openai", "fake"]).default(isProduction ? "openai" : "fake"),
    OPENAI_DEFAULT_MODEL: z.string().default(""),
    /** ローカル開発だけで使う共通キー（本番では組織ごとのキーのみ使う） */
    OPENAI_API_KEY: z.string().optional(),

    // 日本語 → Agent Project Draft の生成（OpenAI Responses API）
    ANTHROPIC_API_KEY: z.string().optional(),
    MANIFEST_GENERATOR_MODEL: z.string().default("gpt-5.6"),

    // Provider OAuth（tokenは交換後にSecret Storeへ保存し、DBや画面へ返さない）
    QIITA_OAUTH_CLIENT_ID: z.string().optional(),
    QIITA_OAUTH_CLIENT_SECRET: z.string().optional(),

    // Worker
    WORKER_ID: z.string().default(`${hostname()}-${process.pid}`),
    WORKER_MAX_CONCURRENT_RUNS: z.coerce.number().int().min(1).default(20),
    SESSION_MAX_LIFETIME_MINUTES: z.coerce.number().int().default(120),
    SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().default(15),
    WORKER_CONNECT_TIMEOUT_MINUTES: z.coerce.number().int().default(10),
    /** OpenAI が入力を受理してから root Turn を作るまで待つ時間 */
    AGENT_TURN_START_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(45),
    /** Turn が始まらない場合に Session を安全に作り直す最大回数 */
    AGENT_TURN_MAX_RECOVERIES: z.coerce.number().int().min(0).max(5).default(2),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    // 本番で開発用の設定が有効になっていたら起動しない
    const devOnly: [boolean, string][] = [
      [env.AUTH_MODE === "dev", "AUTH_MODE=dev は本番では使えません"],
      [env.RUNTIME_IDENTITY_MODE === "dev", "RUNTIME_IDENTITY_MODE=dev は本番では使えません"],
      [env.SECRETS_MODE !== "aws", `SECRETS_MODE=${env.SECRETS_MODE} は本番では使えません`],
      [!env.RUNTIME_TOKEN_SECRET, "RUNTIME_TOKEN_SECRET が必要です"],
      [env.APP_ENV === "production" && env.AGENTS_API_MODE === "fake", "本番環境では AGENTS_API_MODE=fake は使えません"],
    ];
    for (const [bad, message] of devOnly) {
      if (bad) ctx.addIssue({ code: "custom", message });
    }
    if (env.AUTH_MODE === "cognito" && (!env.COGNITO_USER_POOL_ID || !env.COGNITO_CLIENT_ID)) {
      ctx.addIssue({ code: "custom", message: "COGNITO_USER_POOL_ID と COGNITO_CLIENT_ID が必要です" });
    }
    if (env.MANAGED_RUNTIME_PROVISIONING_ROLE_ARN) {
      const required: [string | undefined, string][] = [
        [env.MANAGED_RUNTIME_STATE_BUCKET, "MANAGED_RUNTIME_STATE_BUCKET が必要です"],
        [env.MANAGED_RUNTIME_IMAGE_REGISTRY, "MANAGED_RUNTIME_IMAGE_REGISTRY が必要です"],
        [env.MANAGED_RUNTIME_IMAGE_TAG, "MANAGED_RUNTIME_IMAGE_TAG が必要です"],
      ];
      for (const [value, message] of required) if (!value) ctx.addIssue({ code: "custom", message });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const messages = result.error.issues.map((i) => `- ${i.path.join(".") || "(env)"}: ${i.message}`).join("\n");
    throw new Error(`環境変数が正しくありません:\n${messages}`);
  }
  return result.data;
}

/** 開発用の固定値（本番では superRefine で必須にしている） */
export function runtimeTokenSecret(env: Env): string {
  return env.RUNTIME_TOKEN_SECRET ?? "local-development-runtime-token-secret-0123456789";
}
