import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(level: string, name = "runtime-controller"): Logger {
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
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}

/** エラーをログ用の安全な形にする（スタックは debug のときだけ見る想定） */
export function errorInfo(err: unknown): { message: string; name?: string; code?: string; status?: number } {
  if (err instanceof Error) {
    const e = err as Error & { code?: unknown; status?: unknown };
    return {
      message: e.message,
      name: e.name,
      ...(typeof e.code === "string" ? { code: e.code } : {}),
      ...(typeof e.status === "number" ? { status: e.status } : {}),
    };
  }
  return { message: String(err) };
}
