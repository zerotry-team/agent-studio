import { GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/** 業務システムの認証情報が取得できない（値はエラーに含めない） */
export class SecretUnavailableError extends Error {
  constructor(readonly secretName: string, options?: { cause?: unknown }) {
    super(`認証情報 ${secretName} を取得できません`, options);
    this.name = "SecretUnavailableError";
  }
}

/** Connection の認証情報（config.yaml の connections の論理名で引く） */
export interface ConnectionSecretProvider {
  get(name: string): Promise<string>;
}

/** Secrets Manager の `${prefix}${name}` を読む。5 分キャッシュする */
export class SecretsManagerConnectionSecrets implements ConnectionSecretProvider {
  private readonly cache = new Map<string, { value: string; expiresAt: number }>();

  constructor(
    private readonly client: Pick<SecretsManagerClient, "send">,
    private readonly prefix: string,
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async get(name: string): Promise<string> {
    const hit = this.cache.get(name);
    if (hit && hit.expiresAt > this.now()) return hit.value;
    let value: string | undefined;
    try {
      const out = await this.client.send(new GetSecretValueCommand({ SecretId: `${this.prefix}${name}` }));
      value = out.SecretString ?? undefined;
    } catch (err) {
      throw new SecretUnavailableError(name, { cause: err });
    }
    if (!value) throw new SecretUnavailableError(name);
    this.cache.set(name, { value, expiresAt: this.now() + this.ttlMs });
    return value;
  }
}

/** ローカル開発用: CONNECTION_SECRET_<UPPER_SNAKE_NAME> を読む */
export class EnvConnectionSecrets implements ConnectionSecretProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  static variableName(name: string): string {
    return `CONNECTION_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  }

  async get(name: string): Promise<string> {
    const value = this.env[EnvConnectionSecrets.variableName(name)];
    if (!value) throw new SecretUnavailableError(name);
    return value;
  }
}
