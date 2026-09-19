import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptSession, deriveSessionKey, encryptSession, seal, unseal, type SessionData } from "./session-crypto";

const SECRET = "test-session-secret-that-is-long-enough-123456";

const session: SessionData = {
  id_token: "eyJhbGciOiJSUzI1NiJ9.payload.signature",
  refresh_token: "refresh-token-value",
  expires_at: 1_900_000_000,
  email: "owner@sample-a.example",
};

describe("session-crypto", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("derives a 32-byte key from the secret (SHA-256)", async () => {
    const key = await deriveSessionKey(SECRET);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.byteLength).toBe(32);
    expect(await deriveSessionKey(SECRET)).toEqual(key);
  });

  it("round-trips a session through encrypt/decrypt", async () => {
    const token = await encryptSession(session, SECRET, 3600);
    expect(token.split(".")).toHaveLength(5); // JWE compact serialization
    expect(token).not.toContain("refresh-token-value");
    expect(await decryptSession(token, SECRET)).toEqual(session);
  });

  it("keeps a null refresh token (dev sessions)", async () => {
    const dev: SessionData = { id_token: "dev:owner@sample-a.example", refresh_token: null, expires_at: 1_900_000_000, email: null };
    const token = await encryptSession(dev, SECRET, 60);
    expect(await decryptSession(token, SECRET)).toEqual(dev);
  });

  it("rejects a token encrypted with another secret", async () => {
    const token = await encryptSession(session, SECRET, 3600);
    expect(await decryptSession(token, "another-secret-another-secret-another")).toBeNull();
  });

  it("rejects a tampered token", async () => {
    const token = await encryptSession(session, SECRET, 3600);
    const parts = token.split(".");
    const ciphertext = parts[3]!;
    parts[3] = (ciphertext[0] === "A" ? "B" : "A") + ciphertext.slice(1);
    expect(await decryptSession(parts.join("."), SECRET)).toBeNull();
    expect(await decryptSession("not-a-jwe", SECRET)).toBeNull();
  });

  it("rejects an expired token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T00:00:00Z"));
    const token = await seal({ a: 1 }, SECRET, 60);
    expect(await unseal(token, SECRET)).toMatchObject({ a: 1 });
    vi.setSystemTime(new Date("2026-09-19T00:05:00Z"));
    expect(await unseal(token, SECRET)).toBeNull();
  });

  it("rejects payloads that do not look like a session", async () => {
    const token = await seal({ id_token: 123 }, SECRET, 60);
    expect(await decryptSession(token, SECRET)).toBeNull();
  });
});
