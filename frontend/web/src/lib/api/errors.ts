import type { ApiErrorBody } from "@agent-studio/contracts";

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation_error"
  | "conflict"
  | "failed_precondition"
  | "internal"
  | "unavailable"
  | "no_organization"
  | (string & {});

const DEFAULT_MESSAGES: Record<number, string> = {
  400: "入力内容に誤りがあります。内容を確認してください",
  401: "ログインの有効期限が切れました。もう一度ログインしてください",
  403: "この操作を行う権限がありません",
  404: "対象が見つかりませんでした。削除された可能性があります",
  409: "ほかの操作と重なりました。画面を更新してから、もう一度お試しください",
  412: "この操作を行うための条件がそろっていません",
  429: "操作が集中しています。少し待ってから、もう一度お試しください",
};

const CODE_BY_STATUS: Record<number, ApiErrorCode> = {
  400: "validation_error",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  412: "failed_precondition",
};

export const SERVER_ERROR_MESSAGE = "サーバーでエラーが発生しました。時間をおいて、もう一度お試しください";
export const UNAVAILABLE_MESSAGE = "サーバーに接続できませんでした。時間をおいて、もう一度お試しください";
export const TIMEOUT_MESSAGE = "時間内に応答がありませんでした。処理が続いている場合もあるので、画面を開き直して確認してください";

/** Agent Studio API のエラー。message は利用者にそのまま見せてよい日本語 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ApiErrorCode,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** 入力エラーの項目ごとのメッセージ（details から読み取れる場合） */
  get fieldErrors(): Record<string, string> | undefined {
    return fieldErrorsFromDetails(this.details);
  }
}

function isApiErrorBody(body: unknown): body is ApiErrorBody {
  if (!body || typeof body !== "object") return false;
  const error = (body as { error?: unknown }).error;
  return (
    !!error &&
    typeof error === "object" &&
    typeof (error as { message?: unknown }).message === "string" &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

export function defaultMessageForStatus(status: number): string {
  return DEFAULT_MESSAGES[status] ?? SERVER_ERROR_MESSAGE;
}

/** HTTP ステータスと応答本文から ApiError を作る */
export function toApiError(status: number, body: unknown): ApiError {
  if (isApiErrorBody(body)) {
    const message = body.error.message.trim() || defaultMessageForStatus(status);
    return new ApiError(message, status, body.error.code, body.error.details);
  }
  return new ApiError(defaultMessageForStatus(status), status, CODE_BY_STATUS[status] ?? "internal");
}

/** 待ち時間切れか、そもそも繋がらなかったかで文面を分ける */
function isTimeout(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
}

export function unavailableError(cause?: unknown): ApiError {
  const err = new ApiError(isTimeout(cause) ? TIMEOUT_MESSAGE : UNAVAILABLE_MESSAGE, 0, "unavailable");
  if (cause !== undefined) (err as { cause?: unknown }).cause = cause;
  return err;
}

/**
 * details から項目ごとのエラーを取り出す。次の形に対応する:
 * - [{ path: "a.b", message }]、{ issues: [{ path: ["a","b"] | "a.b", message }] }、{ fieldErrors: { a: ["..."] } }
 */
export function fieldErrorsFromDetails(details: unknown): Record<string, string> | undefined {
  if (!details || typeof details !== "object") return undefined;
  const out: Record<string, string> = {};
  const addIssue = (issue: unknown) => {
    if (!issue || typeof issue !== "object") return;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (typeof message !== "string") return;
    const key = Array.isArray(path) ? path.map(String).join(".") : typeof path === "string" ? path : "";
    if (!(key in out)) out[key] = message;
  };
  if (Array.isArray(details)) details.forEach(addIssue);
  const d = details as { issues?: unknown; errors?: unknown; fieldErrors?: unknown };
  if (Array.isArray(d.issues)) d.issues.forEach(addIssue);
  if (Array.isArray(d.errors)) d.errors.forEach(addIssue);
  if (d.fieldErrors && typeof d.fieldErrors === "object") {
    for (const [key, value] of Object.entries(d.fieldErrors as Record<string, unknown>)) {
      const first = Array.isArray(value) ? value[0] : value;
      if (typeof first === "string" && !(key in out)) out[key] = first;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
