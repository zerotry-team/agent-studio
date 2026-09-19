/** API のエラー。message は利用者にそのまま見せてよい日本語にする */
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 412 | 429 | 500 | 502 | 503,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const unauthorized = (message = "ログインが必要です") => new AppError("unauthorized", 401, message);
export const forbidden = (message = "この操作を行う権限がありません") => new AppError("forbidden", 403, message);
export const notFound = (what = "対象") => new AppError("not_found", 404, `${what}が見つかりません`);
export const validationError = (message: string, details?: unknown) =>
  new AppError("validation_error", 400, message, details);
export const conflict = (message: string) => new AppError("conflict", 409, message);
export const preconditionFailed = (message: string, details?: unknown) =>
  new AppError("failed_precondition", 412, message, details);
