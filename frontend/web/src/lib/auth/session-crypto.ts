import { EncryptJWT, jwtDecrypt, type JWTPayload } from "jose";

/**
 * Cookie に保存するセッション。JWE（alg=dir, enc=A256GCM）で暗号化する。
 * 鍵は SESSION_SECRET の SHA-256。Node.js と Edge Runtime（middleware）のどちらでも動く。
 */
export interface SessionData {
  /** API に Bearer で送るトークン（Cognito の ID トークン、または開発用の `dev:<email>`） */
  id_token: string;
  refresh_token: string | null;
  /** id_token の有効期限（UNIX 秒） */
  expires_at: number;
  email?: string | null;
}

const encoder = new TextEncoder();

export async function deriveSessionKey(secret: string): Promise<Uint8Array> {
  if (!secret) throw new Error("SESSION_SECRET is empty");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return new Uint8Array(digest);
}

/** 任意の claims を暗号化する */
export async function seal(claims: JWTPayload, secret: string, maxAgeSeconds: number): Promise<string> {
  const key = await deriveSessionKey(secret);
  const now = Math.floor(Date.now() / 1000);
  return new EncryptJWT(claims)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt(now)
    .setExpirationTime(now + maxAgeSeconds)
    .encrypt(key);
}

/** 復号する。改ざん・期限切れ・鍵の不一致はすべて null */
export async function unseal(token: string, secret: string): Promise<JWTPayload | null> {
  try {
    const key = await deriveSessionKey(secret);
    const { payload } = await jwtDecrypt(token, key, {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    return payload;
  } catch {
    return null;
  }
}

export async function encryptSession(data: SessionData, secret: string, maxAgeSeconds: number): Promise<string> {
  return seal(
    {
      id_token: data.id_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
      email: data.email ?? null,
    },
    secret,
    maxAgeSeconds,
  );
}

export async function decryptSession(token: string, secret: string): Promise<SessionData | null> {
  const payload = await unseal(token, secret);
  if (!payload) return null;
  const { id_token, refresh_token, expires_at, email } = payload as Record<string, unknown>;
  if (typeof id_token !== "string" || id_token.length === 0) return null;
  if (typeof expires_at !== "number") return null;
  if (refresh_token !== null && typeof refresh_token !== "string") return null;
  return {
    id_token,
    refresh_token: (refresh_token as string | null) ?? null,
    expires_at,
    email: typeof email === "string" ? email : null,
  };
}
