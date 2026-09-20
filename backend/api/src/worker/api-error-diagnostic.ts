/** 診断に必要なフィールドだけを抽出する。リクエスト本文・全ヘッダー・キーは保存しない。 */
export function apiErrorDiagnostic(error: unknown) {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const nested = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : {};
  const clean = (value: unknown): string | null => typeof value === "string"
    ? value.replace(/\bsk-[\w-]+/g, "[REDACTED]").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 1500) : null;
  const headers = record.headers;
  const requestId = headers && typeof headers === "object"
    ? ("get" in headers && typeof headers.get === "function" ? headers.get("x-request-id") : (headers as Record<string, unknown>)["x-request-id"])
    : null;
  return {
    name: clean(record.name),
    code: clean(record.code ?? nested.code),
    http_status: typeof record.status === "number" ? record.status : null,
    request_id: clean(record.requestID ?? requestId),
    message: clean(record.message ?? nested.message) ?? "詳細不明のAPIエラー",
  };
}
