import { SignJWT, jwtVerify } from "jose";
import { unauthorized } from "../../domain/errors.js";

const AUDIENCE = "agent-studio-runtime";
export const RUNTIME_TOKEN_TTL_SECONDS = 15 * 60;

export interface RuntimeClaims {
  runtimeId: string;
  organizationId: string;
}

/** Runtime 用の短期アクセストークン（RTM-04）。HS256・15分 */
export class RuntimeTokenIssuer {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly issuer: string,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  async issue(claims: RuntimeClaims): Promise<{ token: string; expiresIn: number }> {
    const token = await new SignJWT({ org: claims.organizationId })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(claims.runtimeId)
      .setIssuer(this.issuer)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${RUNTIME_TOKEN_TTL_SECONDS}s`)
      .sign(this.key);
    return { token, expiresIn: RUNTIME_TOKEN_TTL_SECONDS };
  }

  async verify(token: string): Promise<RuntimeClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.issuer,
        audience: AUDIENCE,
        algorithms: ["HS256"],
      });
      if (typeof payload.sub !== "string" || typeof payload.org !== "string") throw new Error("claims");
      return { runtimeId: payload.sub, organizationId: payload.org };
    } catch {
      throw unauthorized("Runtime のトークンが無効です");
    }
  }
}
