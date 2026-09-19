import "server-only";
import type { CognitoSettings } from "./cognito";

/**
 * 認証まわりの環境変数。イメージは一度だけビルドして実行時に設定するため、
 * モジュールの読み込み時ではなく、必ずリクエストの処理中に読む。
 */
export type AuthMode = "cognito" | "dev";

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

const DEV_FALLBACK_SESSION_SECRET = "agent-studio-local-development-session-secret-do-not-use";
let warnedFallbackSecret = false;

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function getAuthMode(): AuthMode {
  const raw = (process.env.AUTH_MODE ?? "").trim().toLowerCase();
  const mode: AuthMode = raw === "dev" ? "dev" : raw === "cognito" ? "cognito" : isProduction() ? "cognito" : "dev";
  if (mode === "dev" && isProduction()) {
    throw new AuthConfigError("AUTH_MODE=dev は本番環境（NODE_ENV=production）では使えません");
  }
  return mode;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new AuthConfigError(`環境変数 ${name} が設定されていません`);
  return value;
}

export function getCognitoSettings(): CognitoSettings {
  return {
    domain: required("COGNITO_DOMAIN").replace(/\/+$/, ""),
    clientId: required("COGNITO_CLIENT_ID"),
    clientSecret: required("COGNITO_CLIENT_SECRET"),
    appBaseUrl: required("APP_BASE_URL").replace(/\/+$/, ""),
  };
}

export function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (secret) {
    if (isProduction() && secret.length < 32) {
      throw new AuthConfigError("SESSION_SECRET は 32 文字以上にしてください");
    }
    return secret;
  }
  if (isProduction()) throw new AuthConfigError("環境変数 SESSION_SECRET が設定されていません");
  if (!warnedFallbackSecret) {
    warnedFallbackSecret = true;
    console.warn("[auth] SESSION_SECRET が未設定のため、開発用の固定値を使います（本番では必ず設定してください）");
  }
  return DEV_FALLBACK_SESSION_SECRET;
}

export function isSecureCookie(): boolean {
  return isProduction();
}
