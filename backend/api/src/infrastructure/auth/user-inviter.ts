import {
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import type { Env } from "../../env.js";

/** 招待した利用者がログインできるようにする（Cognito では招待メールが届く） */
export interface UserInviter {
  invite(email: string): Promise<void>;
}

export class CognitoUserInviter implements UserInviter {
  private readonly client: CognitoIdentityProviderClient;

  constructor(
    region: string,
    private readonly userPoolId: string,
  ) {
    this.client = new CognitoIdentityProviderClient({ region });
  }

  async invite(email: string): Promise<void> {
    try {
      await this.client.send(
        new AdminCreateUserCommand({
          UserPoolId: this.userPoolId,
          Username: email,
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
          ],
          DesiredDeliveryMediums: ["EMAIL"],
        }),
      );
    } catch (e) {
      // すでに Cognito にいる利用者（他の組織のメンバーなど）はそのまま使う
      if (e instanceof UsernameExistsException) return;
      throw e;
    }
  }
}

/** ローカル開発: Cognito を使わない */
export class NoopUserInviter implements UserInviter {
  async invite(): Promise<void> {}
}

export function createUserInviter(env: Env): UserInviter {
  return env.AUTH_MODE === "cognito" && env.COGNITO_USER_POOL_ID
    ? new CognitoUserInviter(env.AWS_REGION, env.COGNITO_USER_POOL_ID)
    : new NoopUserInviter();
}
