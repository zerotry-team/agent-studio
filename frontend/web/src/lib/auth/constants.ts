/** 暗号化したセッション（ID トークン・リフレッシュトークン）。値が大きいので `as_session.0`, `as_session.1`… に分割して保存する */
export const SESSION_COOKIE = "as_session";
/** ログイン途中の state / code_verifier（10 分だけ有効） */
export const OAUTH_COOKIE = "as_oauth";
/** 外部Connector OAuthの短期state。Agent Studioログイン用OAuthとは分離する。 */
export const CONNECTOR_OAUTH_COOKIE = "as_connector_oauth";
/** 操作中の組織（UUID） */
export const ORG_COOKIE = "as_org";

/** セッションの最大の長さ（秒）。リフレッシュトークンが先に失効した場合は再ログインになる */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
/** ログイン途中の情報の有効期限（秒） */
export const OAUTH_STATE_MAX_AGE_SECONDS = 60 * 10;
/** ID トークンの残りがこれを下回ったらリフレッシュする（秒） */
export const REFRESH_THRESHOLD_SECONDS = 60 * 5;

/** 認証なしで表示できるパス */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/auth" ||
    pathname.startsWith("/auth/") ||
    pathname === "/api/health" ||
    pathname.startsWith("/_next/")
  );
}

/** middleware が付ける「表示しようとしたパス」のヘッダ（ログイン後に戻る先を作るため） */
export const PATHNAME_HEADER = "x-as-pathname";
