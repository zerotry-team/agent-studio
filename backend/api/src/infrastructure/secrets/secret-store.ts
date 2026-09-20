import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  ResourceNotFoundException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type { Env } from "../../env.js";

/**
 * Agent Studio 側で保管するシークレット（組織の OpenAI キー、studio 接続先の認証情報）。
 * 値は DB に保存せず、DB には参照（ARN）だけを持つ（CONN-02 / SEC-08）。
 */
export interface SecretStore {
  /** 作成または更新し、参照（ARN）を返す */
  put(name: string, value: string, tags?: Record<string, string>): Promise<string>;
  get(ref: string): Promise<string | null>;
}

export class AwsSecretStore implements SecretStore {
  private readonly client: SecretsManagerClient;

  constructor(
    region: string,
    private readonly kmsKeyId?: string,
  ) {
    this.client = new SecretsManagerClient({ region });
  }

  async put(name: string, value: string, tags: Record<string, string> = {}): Promise<string> {
    try {
      const created = await this.client.send(
        new CreateSecretCommand({
          Name: name,
          SecretString: value,
          KmsKeyId: this.kmsKeyId,
          Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
        }),
      );
      return created.ARN!;
    } catch (e) {
      if (!(e instanceof ResourceExistsException)) throw e;
      const updated = await this.client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
      return updated.ARN!;
    }
  }

  async get(ref: string): Promise<string | null> {
    try {
      const res = await this.client.send(new GetSecretValueCommand({ SecretId: ref }));
      return res.SecretString ?? null;
    } catch (e) {
      if (e instanceof ResourceNotFoundException) return null;
      throw e;
    }
  }
}

/** ローカル開発用: JSON ファイルに保存する。API と Worker が同じファイルを見るのでプロセス間で共有できる */
export class FileSecretStore implements SecretStore {
  constructor(private readonly filePath: string) {}

  private async read(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as Record<string, string>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
  }

  async put(name: string, value: string): Promise<string> {
    const arn = `arn:aws:secretsmanager:local:000000000000:secret:${name}`;
    const values = await this.read();
    values[arn] = value;
    await mkdir(dirname(resolve(this.filePath)), { recursive: true });
    // 他のプロセスが半端な内容を読まないよう、一時ファイルに書いてから置き換える
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(values, null, 2), { mode: 0o600 });
    await rename(tmp, this.filePath);
    return arn;
  }

  async get(ref: string): Promise<string | null> {
    return (await this.read())[ref] ?? null;
  }
}

/** テスト用（プロセス内だけ・本番では env.ts が起動を止める） */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  async put(name: string, value: string): Promise<string> {
    const arn = `arn:aws:secretsmanager:local:000000000000:secret:${name}`;
    this.values.set(arn, value);
    return arn;
  }

  async get(ref: string): Promise<string | null> {
    return this.values.get(ref) ?? null;
  }
}

export function createSecretStore(env: Env): SecretStore {
  switch (env.SECRETS_MODE) {
    case "aws":
      return new AwsSecretStore(env.AWS_REGION, env.SECRETS_KMS_KEY_ID);
    case "file":
      return new FileSecretStore(env.SECRETS_FILE);
    case "memory":
      return new MemorySecretStore();
  }
}

/** シークレット名の規約（deployment-contract.md §4.1） */
export const secretNames = {
  openAiAppKey: (prefix: string, organizationId: string) => `${prefix}/orgs/${organizationId}/openai-app-key`,
  openAiEnvKey: (prefix: string, organizationId: string) => `${prefix}/orgs/${organizationId}/openai-env-key`,
  connection: (prefix: string, organizationId: string, connectionId: string) =>
    `${prefix}/orgs/${organizationId}/connections/${connectionId}`,
  connectorOAuthApp: (prefix: string, organizationId: string, connectorId: string) =>
    `${prefix}/orgs/${organizationId}/connectors/${connectorId}/oauth-client-secret`,
};
