import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Env } from "../../env.js";

export interface StoredObject {
  key: string;
  size: number;
}

/** 実行の成果物と監査ログの書き出し先（S3） */
export interface ObjectStore {
  put(bucket: string, key: string, body: Buffer | string, contentType: string): Promise<void>;
  exists(bucket: string, key: string): Promise<boolean>;
  list(bucket: string, prefix: string, limit?: number): Promise<StoredObject[]>;
  /** 期限付きのダウンロード URL */
  presignGet(bucket: string, key: string, expiresInSeconds: number): Promise<string>;
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;

  constructor(region: string) {
    this.client = new S3Client({ region });
  }

  async put(bucket: string, key: string, body: Buffer | string, contentType: string): Promise<void> {
    // バケットは SSE-KMS と Object Lock（監査ログ）。チェックサムは SDK が付ける
    await this.client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async exists(bucket: string, key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (e) {
      if (e instanceof NotFound || (e as { name?: string }).name === "NotFound") return false;
      throw e;
    }
  }

  async list(bucket: string, prefix: string, limit = 200): Promise<StoredObject[]> {
    const res = await this.client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: limit }));
    return (res.Contents ?? []).map((o) => ({ key: o.Key!, size: o.Size ?? 0 }));
  }

  presignGet(bucket: string, key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresInSeconds });
  }
}

/** ローカル開発・テスト用 */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();

  async put(bucket: string, key: string, body: Buffer | string): Promise<void> {
    this.objects.set(`${bucket}/${key}`, Buffer.isBuffer(body) ? body : Buffer.from(body));
  }

  async exists(bucket: string, key: string): Promise<boolean> {
    return this.objects.has(`${bucket}/${key}`);
  }

  async list(bucket: string, prefix: string, limit = 200): Promise<StoredObject[]> {
    return [...this.objects.entries()]
      .filter(([k]) => k.startsWith(`${bucket}/${prefix}`))
      .slice(0, limit)
      .map(([k, v]) => ({ key: k.slice(bucket.length + 1), size: v.length }));
  }

  async presignGet(bucket: string, key: string): Promise<string> {
    return `memory://${bucket}/${key}`;
  }
}

export function createObjectStore(env: Env): ObjectStore {
  return env.SECRETS_MODE === "aws" ? new S3ObjectStore(env.AWS_REGION) : new MemoryObjectStore();
}

/** 実行の成果物のキー（組織ごとのプレフィックス。RUN-06） */
export const artifactPrefix = (organizationId: string, runId: string) => `orgs/${organizationId}/runs/${runId}/`;
