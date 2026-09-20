const REDACTED = "[REDACTED]";
const REDACTED_BASE64 = "[REDACTED_BASE64]";

const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passcode|secret|token|access[_-]?token|refresh[_-]?token|session[_-]?token|bootstrap[_-]?token|environment[_-]?key|api[_-]?key|app[_-]?api[_-]?key|environment[_-]?api[_-]?key|identity)$/i;
const DATA_URL = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/_=-]+/gi;
const LONG_BASE64 = /(?:[A-Za-z0-9+/_-]{4}){64,}(?:[A-Za-z0-9+/_-]{2}==|[A-Za-z0-9+/_-]{3}=)?/g;
const AUTH_VALUE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi;
const HEADER_VALUE = /\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*([^\s,;]+)/gi;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g;
const URL_SECRET = /([?&](?:access_token|refresh_token|token|api_key|key|secret|password)=)[^&#\s]+/gi;
const JSON_SECRET = /(["'](?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|secret|password|cookie|authorization)["']\s*:\s*["'])[^"']+/gi;

/**
 * ログへ渡す文字列から、認証Headerと画像などの長いBase64を除く。
 * 構造化ログのkey redactionだけではError.messageやURL文字列内を保護できないため、
 * loggerのhookからすべての引数へ適用する。
 */
export function redactLogText(value: string): string {
  return value
    .replace(DATA_URL, `data:image/[REDACTED];base64,${REDACTED_BASE64}`)
    .replace(LONG_BASE64, REDACTED_BASE64)
    .replace(AUTH_VALUE, `$1 ${REDACTED}`)
    .replace(HEADER_VALUE, (_match, name: string) => `${name}=${REDACTED}`)
    .replace(JWT_VALUE, REDACTED)
    .replace(URL_SECRET, `$1${REDACTED}`)
    .replace(JSON_SECRET, `$1${REDACTED}`);
}

/** ログ用の値を再帰的に複製し、秘密値を除く。循環参照も安全に扱う。 */
export function redactLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactLogText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (value instanceof Error) {
    const error = value as Error & { code?: unknown; status?: unknown; cause?: unknown };
    return {
      name: error.name,
      message: redactLogText(error.message),
      stack: error.stack ? redactLogText(error.stack) : undefined,
      ...(error.code !== undefined ? { code: redactLogValue(error.code, seen) } : {}),
      ...(error.status !== undefined ? { status: redactLogValue(error.status, seen) } : {}),
      ...(error.cause !== undefined ? { cause: redactLogValue(error.cause, seen) } : {}),
    };
  }

  if (Array.isArray(value)) return value.map((item) => redactLogValue(item, seen));

  const record = value as Record<string, unknown>;
  const imageContent = record.type === "image" || (typeof record.mimeType === "string" && record.mimeType.startsWith("image/"));
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) || (imageContent && key === "data") ? REDACTED : redactLogValue(item, seen),
    ]),
  );
}
