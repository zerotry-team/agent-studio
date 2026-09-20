import pino from "pino";
import { redactLogValue } from "@agent-studio/contracts";

export type Logger = pino.Logger;

export function createLogger(level: string, name: string, destination?: pino.DestinationStream): Logger {
  return pino({
    name,
    level,
    // トークンや鍵をログに出さない
    redact: {
      paths: [
        "req.headers.authorization",
        "headers.authorization",
        "authorization",
        "*.authorization",
        "*.access_token",
        "*.bootstrap_token",
        "*.environment_key",
        "*.api_key",
        "*.app_api_key",
        "*.environment_api_key",
        "*.value",
        "*.session_token",
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
  }, destination);
}
