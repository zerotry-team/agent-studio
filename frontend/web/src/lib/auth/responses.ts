import "server-only";

/** 同じオリジン内へのリダイレクト。Location を相対パスにして、プロキシの内側のホスト名を出さない */
export function redirectTo(path: string, status: 302 | 303 | 307 = 303): Response {
  return new Response(null, { status, headers: { Location: path, "Cache-Control": "no-store" } });
}

/** 外部（Cognito）へのリダイレクト */
export function redirectToExternal(url: string, status: 302 | 303 = 302): Response {
  return new Response(null, { status, headers: { Location: url, "Cache-Control": "no-store" } });
}

export type AuthErrorReason = "state" | "token" | "denied" | "config" | "dev_disabled";

export function authErrorPath(reason: AuthErrorReason): string {
  return `/auth/error?reason=${reason}`;
}
