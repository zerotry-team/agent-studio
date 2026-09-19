import "server-only";
import { isRedirectError } from "next/dist/client/components/redirect";
import { AuthConfigError } from "@/lib/auth/config";
import { SessionExpiredError } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/utils/action-result";
import { InputValidationError } from "@/lib/utils/validation";
import { ApiError, SERVER_ERROR_MESSAGE } from "./errors";

/**
 * Server Action の共通処理。try/catch で例外を捕まえ、利用者に見せる日本語のメッセージにして返す。
 * @param fallbackMessage 想定外のエラーのときに表示するメッセージ
 */
export async function runAction<T>(fn: () => Promise<T>, fallbackMessage: string): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (e) {
    if (isRedirectError(e)) throw e;
    if (e instanceof SessionExpiredError) {
      return { ok: false, code: "session_expired", error: e.message };
    }
    if (e instanceof InputValidationError) {
      return { ok: false, code: "validation_error", error: e.message, fieldErrors: e.fieldErrors };
    }
    if (e instanceof ApiError) {
      if (e.status >= 500) console.error("[api]", e.status, e.code, e.message);
      return {
        ok: false,
        code: e.code,
        error: e.status >= 500 && !e.message ? SERVER_ERROR_MESSAGE : e.message,
        fieldErrors: e.fieldErrors,
      };
    }
    if (e instanceof AuthConfigError) {
      console.error("[config]", e.message);
      return { ok: false, code: "internal", error: "サーバーの設定に誤りがあります。管理者に連絡してください" };
    }
    console.error("[action]", e);
    return { ok: false, code: "internal", error: fallbackMessage };
  }
}
