import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8931),
  BROWSER_SESSION_TOKEN: z.string().min(16),
  BROWSER_MODE: z.enum(["public_ephemeral", "authenticated_restricted"]).default("public_ephemeral"),
  BROWSER_ALLOWED_DOMAINS: z.string().default(""),
  BROWSER_CODE_EXECUTION_ENABLED: z.enum(["true", "false"]).default("false"),
  BROWSER_COMPUTER_ACTIONS_ENABLED: z.enum(["true", "false"]).default("false"),
  BROWSER_VIEWPORT_WIDTH: z.coerce.number().int().min(320).max(3840).default(1440),
  BROWSER_VIEWPORT_HEIGHT: z.coerce.number().int().min(240).max(2160).default(900),
  BROWSER_LOCALE: z.string().min(2).max(32).default("ja-JP"),
  BROWSER_TIMEZONE: z.string().min(1).max(100).default("Asia/Tokyo"),
  BROWSER_MAX_ACTIONS: z.coerce.number().int().min(1).max(10000).default(500),
  BROWSER_ACTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(30000),
  BROWSER_PROXY_SERVER: z.string().url().optional(),
});

export interface BrowserWorkerConfig {
  port: number;
  sessionToken: string;
  mode: "public_ephemeral" | "authenticated_restricted";
  allowedDomains: string[];
  codeExecutionEnabled: boolean;
  computerActionsEnabled: boolean;
  viewport: { width: number; height: number };
  locale: string;
  timezone: string;
  maxActions: number;
  actionTimeoutMs: number;
  proxyServer?: string;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): BrowserWorkerConfig {
  const env = envSchema.parse(source);
  const codeExecutionEnabled = env.BROWSER_CODE_EXECUTION_ENABLED === "true";
  if (env.BROWSER_MODE === "authenticated_restricted" && codeExecutionEnabled) {
    throw new Error("authenticated_restricted では BROWSER_CODE_EXECUTION_ENABLED=true を指定できません");
  }
  return {
    port: env.PORT,
    sessionToken: env.BROWSER_SESSION_TOKEN,
    mode: env.BROWSER_MODE,
    allowedDomains: [...new Set(env.BROWSER_ALLOWED_DOMAINS.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean))],
    codeExecutionEnabled,
    computerActionsEnabled: env.BROWSER_COMPUTER_ACTIONS_ENABLED === "true",
    viewport: { width: env.BROWSER_VIEWPORT_WIDTH, height: env.BROWSER_VIEWPORT_HEIGHT },
    locale: env.BROWSER_LOCALE,
    timezone: env.BROWSER_TIMEZONE,
    maxActions: env.BROWSER_MAX_ACTIONS,
    actionTimeoutMs: env.BROWSER_ACTION_TIMEOUT_MS,
    proxyServer: env.BROWSER_PROXY_SERVER,
  };
}
