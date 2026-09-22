import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { Env } from "../../env.js";
import { unauthorized } from "../../domain/errors.js";

export interface VerifiedIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
}

export interface IdentityVerifier {
  verify(bearerToken: string): Promise<VerifiedIdentity>;
}

/** Cognito の ID トークンを検証する（署名・発行者・aud・有効期限） */
export class CognitoIdentityVerifier implements IdentityVerifier {
  private readonly verifier;

  /** Web と CLI で別の app client を使うため、aud はその両方を受け付ける */
  constructor(userPoolId: string, clientId: string | string[]) {
    this.verifier = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: "id" });
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    try {
      const payload = await this.verifier.verify(token);
      const email = typeof payload.email === "string" ? payload.email : "";
      if (!email) throw new Error("email がありません");
      return {
        subject: payload.sub,
        email,
        emailVerified: payload.email_verified === true,
        displayName: typeof payload.name === "string" ? payload.name : null,
      };
    } catch {
      throw unauthorized("ログインの有効期限が切れたか、認証情報が正しくありません");
    }
  }
}

/** ローカル開発用: "dev:<email>" をそのまま受け付ける（本番では env.ts が起動を止める） */
export class DevIdentityVerifier implements IdentityVerifier {
  async verify(token: string): Promise<VerifiedIdentity> {
    const match = /^dev:([^\s@]+@[^\s@]+)$/.exec(token);
    if (!match) throw unauthorized();
    const email = match[1]!.toLowerCase();
    return { subject: `dev|${email}`, email, emailVerified: true, displayName: email.split("@")[0] ?? null };
  }
}

export function createIdentityVerifier(env: Env): IdentityVerifier {
  if (env.AUTH_MODE === "dev") return new DevIdentityVerifier();
  const clientIds = [env.COGNITO_CLIENT_ID!, ...(env.COGNITO_CLI_CLIENT_ID ? [env.COGNITO_CLI_CLIENT_ID] : [])];
  return new CognitoIdentityVerifier(env.COGNITO_USER_POOL_ID!, clientIds.length === 1 ? clientIds[0]! : clientIds);
}
