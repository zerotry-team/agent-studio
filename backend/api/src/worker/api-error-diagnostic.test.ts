import { expect, it } from "vitest";
import { apiErrorDiagnostic } from "./api-error-diagnostic.js";
it("SSEエラーのコードとRequest IDを残し、本文と認証情報を除外する", () => {
  const result = apiErrorDiagnostic({ message: "failed sk-secret-value Bearer credential", error: { code: "usage_limit_exceeded" }, requestID: "req_123", body: "private article", headers: { authorization: "secret" } });
  expect(result).toMatchObject({ code: "usage_limit_exceeded", request_id: "req_123", http_status: null });
  expect(JSON.stringify(result)).not.toMatch(/sk-secret|credential|private article|authorization/);
});
it("HTTPエラーと不明なエラーを扱える", () => {
  expect(apiErrorDiagnostic({ status: 429, headers: new Headers({ "x-request-id": "req_456" }) })).toMatchObject({ http_status: 429, request_id: "req_456" });
  expect(apiErrorDiagnostic(null).message).toBe("詳細不明のAPIエラー");
});
