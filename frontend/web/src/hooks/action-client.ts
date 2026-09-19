"use client";

import { ActionError, isSessionErrorCode, type ActionResult } from "@/lib/utils/action-result";

let redirecting = false;

/** ログインの有効期限が切れたらログイン画面へ移動する */
export function redirectToLogin(): void {
  if (typeof window === "undefined" || redirecting) return;
  redirecting = true;
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/auth/login?next=${encodeURIComponent(next)}`);
}

/**
 * Server Action の結果を取り出す。失敗していれば ActionError（日本語メッセージ）を throw する。
 * セッション切れのときはログイン画面へ移動する。
 */
export async function unwrapAction<T>(promise: Promise<ActionResult<T>>): Promise<T> {
  let result: ActionResult<T>;
  try {
    result = await promise;
  } catch (e) {
    // Server Action 自体を呼べなかった（ネットワークの切断、デプロイ直後など）
    console.error(e);
    throw new ActionError("サーバーと通信できませんでした。ページを再読み込みして、もう一度お試しください", "network");
  }
  if (result.ok) return result.data;
  if (isSessionErrorCode(result.code)) redirectToLogin();
  throw new ActionError(result.error, result.code, result.fieldErrors);
}

export function toActionError(e: unknown): ActionError {
  if (e instanceof ActionError) return e;
  if (e instanceof Error) return new ActionError(e.message || "エラーが発生しました");
  return new ActionError("エラーが発生しました");
}
