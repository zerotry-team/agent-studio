import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type { Logger } from "./logger.js";
import { errorInfo } from "./logger.js";

/** シークレットの読み書き（Secrets Manager、またはローカル開発用のメモリ） */
export interface SecretStore {
  /** 値がない（シークレットが無い・値が未登録）ときは undefined */
  get(secretId: string): Promise<string | undefined>;
  put(secretId: string, value: string): Promise<void>;
}

export class SecretsManagerStore implements SecretStore {
  constructor(private readonly client: Pick<SecretsManagerClient, "send">) {}

  async get(secretId: string): Promise<string | undefined> {
    try {
      const out = await this.client.send(new GetSecretValueCommand({ SecretId: secretId }));
      return out.SecretString ?? undefined;
    } catch (err) {
      // Terraform は値のないシークレットだけを作るため、AWSCURRENT が無いときもここに来る
      if (err instanceof ResourceNotFoundException || (err as { name?: string }).name === "ResourceNotFoundException") {
        return undefined;
      }
      throw err;
    }
  }

  async put(secretId: string, value: string): Promise<void> {
    await this.client.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: value }));
  }
}

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.values.set(k, v);
  }

  async get(secretId: string): Promise<string | undefined> {
    return this.values.get(secretId);
  }

  async put(secretId: string, value: string): Promise<void> {
    this.values.set(secretId, value);
  }
}

/** Bootstrap Token が「まだ無い」「使用済み」を表す値 */
const EMPTY_BOOTSTRAP_VALUES = new Set(["", "unset", "consumed"]);
export const CONSUMED_BOOTSTRAP_VALUE = "consumed";

export interface ControllerSecretsOptions {
  bootstrapTokenSecretId: string;
  environmentKeySecretId: string;
  /** ローカル開発用: 環境変数 BOOTSTRAP_TOKEN */
  bootstrapTokenOverride?: string;
}

/** Controller が扱うシークレット（Bootstrap Token と OpenAI の環境キー） */
export class ControllerSecrets {
  private overrideConsumed = false;

  constructor(
    private readonly store: SecretStore,
    private readonly opts: ControllerSecretsOptions,
    private readonly logger: Logger,
  ) {}

  /** 使える Bootstrap Token。無い・使用済みなら null */
  async readBootstrapToken(): Promise<string | null> {
    const override = this.opts.bootstrapTokenOverride?.trim();
    if (override && !this.overrideConsumed && !EMPTY_BOOTSTRAP_VALUES.has(override)) return override;

    const value = (await this.store.get(this.opts.bootstrapTokenSecretId))?.trim() ?? "";
    return EMPTY_BOOTSTRAP_VALUES.has(value) ? null : value;
  }

  /** 登録に成功したら手元の Bootstrap Token を消す（§8.1 手順 7） */
  async markBootstrapConsumed(): Promise<void> {
    this.overrideConsumed = true;
    try {
      await this.store.put(this.opts.bootstrapTokenSecretId, CONSUMED_BOOTSTRAP_VALUE);
    } catch (err) {
      // トークンは Agent Studio 側で失効済みなので、書き換えに失敗しても再利用はできない
      this.logger.warn({ err: errorInfo(err) }, "Bootstrap Token のシークレットを consumed に書き換えられませんでした");
    }
  }

  async saveEnvironmentKey(key: string): Promise<void> {
    await this.store.put(this.opts.environmentKeySecretId, key);
  }

  async readEnvironmentKey(): Promise<string | null> {
    const v = (await this.store.get(this.opts.environmentKeySecretId))?.trim();
    return v ? v : null;
  }
}
