/**
 * Server Action の戻り値。
 * Next.js は本番ビルドで Server Action から throw したエラーのメッセージを伏せるため、
 * エラーは値として返し、クライアント側（hooks/use-action）で Error に戻して throw する。
 */
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string; fieldErrors?: Record<string, string> };

export class ActionError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "ActionError";
  }
}

/** ログインし直しが必要なエラーコード */
export function isSessionErrorCode(code: string | undefined): boolean {
  return code === "session_expired" || code === "unauthorized";
}
