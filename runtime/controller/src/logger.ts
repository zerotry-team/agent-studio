import pino from "pino";
import { redactLogText, redactLogValue } from "@agent-studio/contracts";

export type Logger = pino.Logger;

export function createLogger(level: string, name = "runtime-controller", destination?: pino.DestinationStream): Logger {
  return pino({
    level,
    // トークン・鍵をログに出さない（念のため。ログに渡す値そのものにも含めないこと）
    redact: {
      paths: [
        "authorization",
        "headers.authorization",
        "*.authorization",
        "*.headers.authorization",
        "access_token",
        "*.access_token",
        "bootstrap_token",
        "*.bootstrap_token",
        "environment_key",
        "*.environment_key",
        "identity",
        "*.identity",
        "*.x-amz-security-token",
      ],
      censor: "[REDACTED]",
    },
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map((value) => redactLogValue(value)) as Parameters<typeof method>);
      },
    },
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  }, destination);
}

/** エラーをログ用の安全な形にする（スタックは debug のときだけ見る想定） */
export function errorInfo(err: unknown): { message: string; name?: string; code?: string; status?: number } {
  if (err instanceof Error) {
    const e = err as Error & { code?: unknown; status?: unknown };
    return {
      message: redactLogText(e.message),
      name: e.name,
      ...(typeof e.code === "string" ? { code: e.code } : {}),
      ...(typeof e.status === "number" ? { status: e.status } : {}),
    };
  }
  return { message: redactLogText(String(err)) };
}
