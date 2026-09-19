import { decodeJwt } from "jose";
import { ensureTrailingSlashless } from "./pkce";
import type { SessionData } from "./session-crypto";

export interface CognitoSettings {
  /** 例: https://<prefix>.auth.ap-northeast-1.amazoncognito.com */
  domain: string;
  clientId: string;
  clientSecret: string;
  /** 例: https://studio.example.com */
  appBaseUrl: string;
}

export interface CognitoTokenResponse {
  id_token: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export class CognitoTokenError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly oauthError?: string,
  ) {
    super(message);
    this.name = "CognitoTokenError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function callbackUrl(settings: Pick<CognitoSettings, "appBaseUrl">): string {
  return `${ensureTrailingSlashless(settings.appBaseUrl)}/auth/callback`;
}

export function buildLogoutUrl(settings: Pick<CognitoSettings, "domain" | "clientId" | "appBaseUrl">): string {
  const url = new URL("/logout", ensureTrailingSlashless(settings.domain) + "/");
  url.search = new URLSearchParams({
    client_id: settings.clientId,
    logout_uri: `${ensureTrailingSlashless(settings.appBaseUrl)}/`,
  }).toString();
  return url.toString();
}

function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

async function postToken(
  settings: CognitoSettings,
  body: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<CognitoTokenResponse> {
  const res = await fetchImpl(`${ensureTrailingSlashless(settings.domain)}/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      authorization: basicAuth(settings.clientId, settings.clientSecret),
    },
    body: new URLSearchParams(body).toString(),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json || typeof json.id_token !== "string") {
    const oauthError = typeof json?.error === "string" ? json.error : undefined;
    throw new CognitoTokenError(`token endpoint returned ${res.status}${oauthError ? ` (${oauthError})` : ""}`, res.status, oauthError);
  }
  return json as unknown as CognitoTokenResponse;
}

export function exchangeAuthorizationCode(
  settings: CognitoSettings,
  params: { code: string; codeVerifier: string },
  fetchImpl: FetchLike = fetch,
): Promise<CognitoTokenResponse> {
  return postToken(
    settings,
    {
      grant_type: "authorization_code",
      client_id: settings.clientId,
      code: params.code,
      redirect_uri: callbackUrl(settings),
      code_verifier: params.codeVerifier,
    },
    fetchImpl,
  );
}

export function refreshIdToken(
  settings: CognitoSettings,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<CognitoTokenResponse> {
  return postToken(
    settings,
    { grant_type: "refresh_token", client_id: settings.clientId, refresh_token: refreshToken },
    fetchImpl,
  );
}

/**
 * トークンエンドポイントの応答からセッションを作る。
 * 有効期限は ID トークンの exp を優先し、読めない場合は expires_in を使う。
 * リフレッシュ時は refresh_token が返らないことがあるので、元の値を引き継ぐ。
 */
export function sessionFromTokenResponse(
  tokens: CognitoTokenResponse,
  previousRefreshToken: string | null = null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SessionData {
  let expiresAt = nowSeconds + (tokens.expires_in ?? 3600);
  let email: string | null = null;
  try {
    const claims = decodeJwt(tokens.id_token);
    if (typeof claims.exp === "number") expiresAt = claims.exp;
    if (typeof claims.email === "string") email = claims.email;
  } catch {
    // ID トークンを読めなくても expires_in で動かす
  }
  return {
    id_token: tokens.id_token,
    refresh_token: tokens.refresh_token ?? previousRefreshToken,
    expires_at: expiresAt,
    email,
  };
}
