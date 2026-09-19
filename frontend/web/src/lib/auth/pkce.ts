/**
 * OAuth 2.0 認可コードフロー + PKCE（RFC 7636）の補助関数。Node.js / Edge のどちらでも動く。
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomUrlSafeString(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** code_verifier: 43〜128 文字の [A-Za-z0-9-._~] */
export function createCodeVerifier(): string {
  return randomUrlSafeString(32);
}

/** code_challenge = BASE64URL(SHA256(code_verifier))（S256） */
export async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export function createState(): string {
  return randomUrlSafeString(24);
}

export interface AuthorizeUrlParams {
  domain: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope?: string;
}

export function buildAuthorizeUrl(p: AuthorizeUrlParams): string {
  const url = new URL("/oauth2/authorize", ensureTrailingSlashless(p.domain) + "/");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: p.scope ?? "openid email profile",
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** 定数時間での文字列比較（state の照合用） */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * ログイン後に戻る先。オープンリダイレクトを防ぐため、同じオリジン内のパスだけを許可する。
 */
export function sanitizeReturnTo(value: string | null | undefined): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (value.startsWith("/auth/")) return "/";
  if (/[\r\n]/.test(value)) return "/";
  return value;
}

export function ensureTrailingSlashless(url: string): string {
  return url.replace(/\/+$/, "");
}
