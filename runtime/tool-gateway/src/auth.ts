import { sha256Hex, type SessionGrant } from "@agent-studio/contracts";
import type { ControllerApi } from "./controller-client.js";

export type AuthResult = { ok: true; grant: SessionGrant; tokenHash: string } | { ok: false; reason: "missing" | "invalid" };

const MAX_TOKEN_LENGTH = 1024;
const MAX_CACHE_ENTRIES = 10_000;

/**
 * セッション用トークン（Authorization: Bearer）を検証して SessionGrant を得る。
 * トークンは SHA-256 にしてから Controller に問い合わせる（平文は保存しない）。
 * 結果は 30 秒（見つからないときは 5 秒）キャッシュする。
 */
export class GrantResolver {
  private readonly cache = new Map<string, { grant: SessionGrant | null; expiresAt: number }>();

  constructor(
    private readonly controller: Pick<ControllerApi, "getGrantByTokenHash">,
    private readonly opts: { positiveTtlMs?: number; negativeTtlMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  static extractBearer(header: string | undefined): string | null {
    if (!header) return null;
    const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (!m || m[1]!.length > MAX_TOKEN_LENGTH) return null;
    return m[1]!;
  }

  /** Controller に到達できないときは例外（呼び出し側で 503 にする） */
  async resolve(authorization: string | undefined): Promise<AuthResult> {
    const token = GrantResolver.extractBearer(authorization);
    if (!token) return { ok: false, reason: authorization ? "invalid" : "missing" };
    const tokenHash = await sha256Hex(token);
    const now = this.now();

    let entry = this.cache.get(tokenHash);
    if (!entry || entry.expiresAt <= now) {
      const grant = await this.controller.getGrantByTokenHash(tokenHash);
      if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.clear();
      const ttl = grant ? (this.opts.positiveTtlMs ?? 30_000) : (this.opts.negativeTtlMs ?? 5_000);
      entry = { grant, expiresAt: now + ttl };
      this.cache.set(tokenHash, entry);
    }
    const grant = entry.grant;
    if (!grant || Date.parse(grant.expires_at) <= now) return { ok: false, reason: "invalid" };
    return { ok: true, grant, tokenHash };
  }
}
