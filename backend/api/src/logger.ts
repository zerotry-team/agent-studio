import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(level: string, name: string): Logger {
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
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
