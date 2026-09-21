import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { ControllerConfig } from "./config.js";

const MAX_PROFILE_BYTES = 4 * 1024 * 1024;
const KEY = /^profiles\/([0-9a-f-]{36})\/([0-9TZ.-]+)\.json$/i;

export interface StoredBrowserProfile {
  key: string;
  sha256: string;
  sizeBytes: number;
}

export interface BrowserProfileStore {
  readonly kind: string;
  put(profileId: string, body: Buffer): Promise<StoredBrowserProfile>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

function assertBody(body: Buffer): void {
  if (body.length === 0 || body.length > MAX_PROFILE_BYTES) throw new Error("Browser Profileのサイズが上限外です");
  JSON.parse(body.toString("utf8"));
}

function assertKey(key: string): void {
  if (!KEY.test(key)) throw new Error("Browser Profile object keyの形式が正しくありません");
}

function objectKey(profileId: string): string {
  return `profiles/${profileId}/${new Date().toISOString().replace(/:/g, "-")}.json`;
}

export class S3BrowserProfileStore implements BrowserProfileStore {
  readonly kind = "s3";
  constructor(
    private readonly s3: Pick<S3Client, "send">,
    private readonly bucket: string,
    private readonly kmsKeyArn: string,
  ) {}

  async put(profileId: string, body: Buffer): Promise<StoredBrowserProfile> {
    assertBody(body);
    const key = objectKey(profileId);
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: "application/json",
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: this.kmsKeyArn,
      Metadata: { profile_id: profileId, sha256: createHash("sha256").update(body).digest("hex") },
    }));
    return { key, sha256: createHash("sha256").update(body).digest("hex"), sizeBytes: body.length };
  }

  async get(key: string): Promise<Buffer> {
    assertKey(key);
    const result = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new Error("Browser Profileが見つかりません");
    const bytes = Buffer.from(await result.Body.transformToByteArray());
    assertBody(bytes);
    return bytes;
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export class FileBrowserProfileStore implements BrowserProfileStore {
  readonly kind = "filesystem";
  constructor(private readonly root: string) {}

  private path(key: string): string {
    assertKey(key);
    return join(this.root, key);
  }

  async put(profileId: string, body: Buffer): Promise<StoredBrowserProfile> {
    assertBody(body);
    const key = objectKey(profileId);
    const path = this.path(key);
    const temporary = `${path}.${process.pid}.tmp`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, path);
    return { key, sha256: createHash("sha256").update(body).digest("hex"), sizeBytes: body.length };
  }

  async get(key: string): Promise<Buffer> {
    const body = await readFile(this.path(key));
    assertBody(body);
    return body;
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

export class DisabledBrowserProfileStore implements BrowserProfileStore {
  readonly kind = "disabled";
  async put(): Promise<StoredBrowserProfile> { throw new Error("Browser Profile Storeが有効になっていません"); }
  async get(): Promise<Buffer> { throw new Error("Browser Profile Storeが有効になっていません"); }
  async delete(): Promise<void> { throw new Error("Browser Profile Storeが有効になっていません"); }
}

export function createBrowserProfileStore(
  config: ControllerConfig["browserProfileStore"],
  s3?: S3Client,
): BrowserProfileStore {
  if (config.type === "s3") {
    if (!s3) throw new Error("S3 clientが必要です");
    return new S3BrowserProfileStore(s3, config.bucket, config.kmsKeyArn);
  }
  if (config.type === "filesystem") return new FileBrowserProfileStore(config.directory);
  return new DisabledBrowserProfileStore();
}
