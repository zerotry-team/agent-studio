import "server-only";
import { cookies } from "next/headers";
import { refreshIdToken, sessionFromTokenResponse } from "./cognito";
import { getAuthMode, getCognitoSettings, getSessionSecret, isSecureCookie } from "./config";
import {
  OAUTH_COOKIE,
  OAUTH_STATE_MAX_AGE_SECONDS,
  REFRESH_THRESHOLD_SECONDS,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from "./constants";
import { chunkName, existingChunkNames, joinChunks, splitIntoChunks } from "./cookie-chunks";
import { decryptSession, encryptSession, seal, unseal, type SessionData } from "./session-crypto";

/** セッションが無い・壊れている・更新できない。ログインし直す必要がある */
export class SessionExpiredError extends Error {
  constructor(message = "ログインの有効期限が切れました。もう一度ログインしてください") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

type CookieStore = ReturnType<typeof cookies>;

export const DEV_TOKEN_PREFIX = "dev:";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function cookieOptions(maxAge: number) {
  return { httpOnly: true, secure: isSecureCookie(), sameSite: "lax" as const, path: "/", maxAge };
}

export function deleteCookie(store: CookieStore, name: string): void {
  store.set(name, "", { ...cookieOptions(0), expires: new Date(0) });
}

// ---------------------------------------------------------------------------
// セッション Cookie
// ---------------------------------------------------------------------------
export async function readSession(store: CookieStore = cookies()): Promise<SessionData | null> {
  const raw = joinChunks(SESSION_COOKIE, (name) => store.get(name)?.value);
  if (!raw) return null;
  return decryptSession(raw, getSessionSecret());
}

export async function writeSession(data: SessionData, store: CookieStore = cookies()): Promise<void> {
  const token = await encryptSession(data, getSessionSecret(), SESSION_MAX_AGE_SECONDS);
  const chunks = splitIntoChunks(token);
  const existing = existingChunkNames(
    SESSION_COOKIE,
    store.getAll().map((c) => c.name),
  );
  chunks.forEach((value, i) => store.set(chunkName(SESSION_COOKIE, i), value, cookieOptions(SESSION_MAX_AGE_SECONDS)));
  for (const name of existing) {
    const index = Number(name.slice(SESSION_COOKIE.length + 1));
    if (index >= chunks.length) deleteCookie(store, name);
  }
}

export function clearAuthCookies(store: CookieStore = cookies()): void {
  for (const name of existingChunkNames(
    SESSION_COOKIE,
    store.getAll().map((c) => c.name),
  )) {
    deleteCookie(store, name);
  }
  deleteCookie(store, OAUTH_COOKIE);
}

export function createDevSession(email: string): SessionData {
  return {
    id_token: `${DEV_TOKEN_PREFIX}${email}`,
    refresh_token: null,
    expires_at: nowSeconds() + SESSION_MAX_AGE_SECONDS,
    email,
  };
}

// ---------------------------------------------------------------------------
// ログイン途中の state / code_verifier
// ---------------------------------------------------------------------------
export interface OAuthState {
  state: string;
  code_verifier: string;
  return_to: string;
}

export async function writeOAuthState(value: OAuthState, store: CookieStore = cookies()): Promise<void> {
  const token = await seal({ ...value }, getSessionSecret(), OAUTH_STATE_MAX_AGE_SECONDS);
  store.set(OAUTH_COOKIE, token, cookieOptions(OAUTH_STATE_MAX_AGE_SECONDS));
}

export async function readOAuthState(store: CookieStore = cookies()): Promise<OAuthState | null> {
  const raw = store.get(OAUTH_COOKIE)?.value;
  if (!raw) return null;
  const payload = await unseal(raw, getSessionSecret());
  if (!payload) return null;
  const { state, code_verifier, return_to } = payload as Record<string, unknown>;
  if (typeof state !== "string" || typeof code_verifier !== "string") return null;
  return { state, code_verifier, return_to: typeof return_to === "string" ? return_to : "/" };
}

// ---------------------------------------------------------------------------
// API に送るトークン（必要ならリフレッシュする）
// ---------------------------------------------------------------------------
const MAX_CACHE_ENTRIES = 500;
/** リフレッシュ結果の一時キャッシュ（Server Component の描画中は Cookie を書き換えられないため） */
const refreshedSessions = new Map<string, SessionData>();
const inflightRefreshes = new Map<string, Promise<SessionData>>();

function isFresh(session: SessionData): boolean {
  return session.expires_at - nowSeconds() > REFRESH_THRESHOLD_SECONDS;
}

async function refreshSession(session: SessionData): Promise<SessionData> {
  const refreshToken = session.refresh_token;
  if (!refreshToken) throw new SessionExpiredError();

  const cached = refreshedSessions.get(refreshToken);
  if (cached && isFresh(cached)) return cached;

  let pending = inflightRefreshes.get(refreshToken);
  if (!pending) {
    pending = (async () => {
      try {
        const tokens = await refreshIdToken(getCognitoSettings(), refreshToken);
        const next = sessionFromTokenResponse(tokens, refreshToken);
        next.email = next.email ?? session.email ?? null;
        refreshedSessions.set(refreshToken, next);
        if (refreshedSessions.size > MAX_CACHE_ENTRIES) {
          const oldest = refreshedSessions.keys().next().value;
          if (oldest !== undefined) refreshedSessions.delete(oldest);
        }
        return next;
      } catch (e) {
        console.warn("[auth] ID トークンのリフレッシュに失敗しました", e instanceof Error ? e.message : e);
        throw new SessionExpiredError();
      } finally {
        inflightRefreshes.delete(refreshToken);
      }
    })();
    inflightRefreshes.set(refreshToken, pending);
  }
  return pending;
}

/**
 * API に送る Bearer トークンを返す。
 * - ID トークンの残りが 5 分未満ならリフレッシュし、可能なら Cookie を更新する
 * - セッションが無い・更新できない場合は SessionExpiredError
 */
export async function getAccessToken(): Promise<string> {
  const store = cookies();
  const session = await readSession(store);
  if (!session) throw new SessionExpiredError();

  const mode = getAuthMode();
  if (session.id_token.startsWith(DEV_TOKEN_PREFIX)) {
    if (mode !== "dev") throw new SessionExpiredError();
    return session.id_token;
  }
  if (mode !== "cognito") throw new SessionExpiredError();
  if (isFresh(session)) return session.id_token;

  const refreshed = await refreshSession(session);
  try {
    await writeSession(refreshed, store);
  } catch {
    // Server Component の描画中は Cookie を書き換えられない。次の Server Action で保存される
  }
  return refreshed.id_token;
}
