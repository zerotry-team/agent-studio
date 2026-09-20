import pino from "pino";
import { redactLogText, redactLogValue } from "@agent-studio/contracts";

export type Logger = pino.Logger;

export function createLogger(level: string, name = "tool-gateway", destination?: pino.DestinationStream): Logger {
  return pino({
    level,
    // トークン・認証情報・ツールの引数をログに出さない（念のため。ログに渡す値そのものにも含めないこと）
    redact: {
      paths: [
        "authorization",
        "headers.authorization",
        "*.authorization",
        "*.headers.authorization",
        "token",
        "*.token",
        "secret",
        "*.secret",
        "args",
        "*.args",
        "arguments",
        "*.arguments",
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

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // fetch の失敗は cause に本当の理由（ECONNREFUSED など）がある
    const cause = (err as Error & { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : undefined;
    return redactLogText(causeMsg && !err.message.includes(causeMsg) ? `${err.message}（${causeMsg}）` : err.message);
  }
  return redactLogText(String(err));
}
