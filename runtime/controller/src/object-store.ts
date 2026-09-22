import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

/**
 * Builder の作業領域と企業専用 Adapter package を置く、顧客 AWS 内の保存先。
 * Control Plane には送らない（ソース本文・Adapter の中身は Runtime の外に出さない）。
 */
export interface ObjectStore {
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  /** 無ければ null */
  get(key: string): Promise<Buffer | null>;
  delete(keys: string[]): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly s3: Pick<S3Client, "send">,
    private readonly bucket: string,
    private readonly kmsKeyArn: string,
  ) {}

  async put(key: string, body: Buffer, contentType = "application/octet-stream"): Promise<void> {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: this.kmsKeyArn,
    }));
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!out.Body) return null;
      return Buffer.from(await out.Body.transformToByteArray());
    } catch (err) {
      if (err instanceof NoSuchKey || (err as { name?: string }).name === "NoSuchKey") return null;
      throw err;
    }
  }

  async delete(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const out = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const item of out.Contents ?? []) if (item.Key) keys.push(item.Key);
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }
}

/** テスト・ローカル用 */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();

  async put(key: string, body: Buffer): Promise<void> {
    this.objects.set(key, Buffer.from(body));
  }

  async get(key: string): Promise<Buffer | null> {
    const hit = this.objects.get(key);
    return hit ? Buffer.from(hit) : null;
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}
