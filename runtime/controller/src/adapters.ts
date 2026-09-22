import { createHash, createPublicKey, verify } from "node:crypto";
import {
  adapterDescriptorSchema,
  canonicalJson,
  type AdapterDescriptor,
  type AdapterInstallResult,
  type InstallAdapterJob,
  type RuntimeToolDelivery,
} from "@agent-studio/contracts";
import { z } from "zod";
import type { Logger } from "./logger.js";
import type { ObjectStore } from "./object-store.js";
import type { StudioApi } from "./studio-client.js";

/** Adapter package（Node の組み込みモジュールだけを使う 1 ファイルの ESM）の上限 */
export const ADAPTER_BUNDLE_MAX_BYTES = 20 * 1024 * 1024;

const installedAdapterSchema = z.object({
  connector_key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  descriptor: adapterDescriptorSchema,
  delivery: z.object({
    connector_key: z.string(),
    contract_hash: z.string(),
    image_digest: z.string(),
    source_commit: z.string(),
    package_signature: z.string(),
  }).strict(),
  installed_at: z.iso.datetime(),
}).strict();
export type InstalledAdapter = z.infer<typeof installedAdapterSchema>;

export const adapterManifestKey = (connectorKey: string) => `adapters/${connectorKey}/manifest.json`;
export const adapterBundleKey = (connectorKey: string) => `adapters/${connectorKey}/bundle.mjs`;

function repositoryPath(url: string): { owner: string; repo: string } {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) throw new Error("GitHubのrepository URLではありません");
  return { owner: match[1]!, repo: match[2]! };
}

export function verifyAdapterPackage(job: InstallAdapterJob, bundle: Buffer): void {
  const digest = `sha256:${createHash("sha256").update(bundle).digest("hex")}`;
  if (digest !== job.image_digest) throw new Error("Adapter packageのdigestが署名済みの値と一致しません");
  const descriptorHash = createHash("sha256").update(canonicalJson(job.descriptor)).digest("hex");
  const contractHash = createHash("sha256").update(canonicalJson(job.descriptor.tools)).digest("hex");
  if (descriptorHash !== job.descriptor_hash || contractHash !== job.contract_hash) throw new Error("Adapter descriptorのhashが一致しません");
  if (job.descriptor.connector.key !== job.connector_key || job.descriptor.source.merge_commit !== job.source_commit) {
    throw new Error("Adapter descriptorのconnector keyまたはmerge commitが一致しません");
  }
  const key = createPublicKey(job.signing_public_key);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Adapter package署名鍵はEd25519公開鍵である必要があります");
  const payload = Buffer.from(canonicalJson({
    source_commit: job.source_commit,
    descriptor_hash: job.descriptor_hash,
    contract_hash: job.contract_hash,
    image_digest: job.image_digest,
    sbom_digest: job.sbom_digest,
  }), "utf8");
  const signature = Buffer.from(job.package_signature, "base64");
  if (signature.length !== 64 || !verify(null, payload, key, signature)) throw new Error("Adapter packageのEd25519署名を検証できません");
}

/**
 * CI が GitHub Release に添付した企業専用 Adapter を取得し、Runtime 内で検証して保存する。
 * Tool Gateway は保存済みのものだけを起動する（Control Plane は Adapter の中身を扱わない）。
 */
export class AdapterInstaller {
  constructor(
    private readonly store: ObjectStore,
    private readonly studio: Pick<StudioApi, "gitCredential">,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly githubApi = "https://api.github.com",
  ) {}

  async install(job: InstallAdapterJob): Promise<AdapterInstallResult> {
    const credential = await this.studio.gitCredential(job.job_id);
    if (credential.repository_url !== job.repository_url) throw new Error("Git資格情報のrepository allowlistが一致しません");
    const { owner, repo } = repositoryPath(job.repository_url);
    // GitHub は署名付き URL へ redirect する。fetch は別 origin への redirect で Authorization を外す
    const res = await this.fetchImpl(`${this.githubApi}/repos/${owner}/${repo}/releases/assets/${job.release_asset_id}`, {
      headers: {
        accept: "application/octet-stream",
        authorization: `Bearer ${credential.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "agent-studio-runtime-controller",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Adapter packageをGitHub Releaseから取得できませんでした（HTTP ${res.status}）`);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > ADAPTER_BUNDLE_MAX_BYTES) throw new Error("Adapter packageが大きすぎます");
    const bundle = Buffer.from(await res.arrayBuffer());
    if (bundle.byteLength > ADAPTER_BUNDLE_MAX_BYTES) throw new Error("Adapter packageが大きすぎます");
    verifyAdapterPackage(job, bundle);

    const delivery: RuntimeToolDelivery = {
      connector_key: job.connector_key,
      contract_hash: job.contract_hash,
      image_digest: job.image_digest,
      source_commit: job.source_commit,
      package_signature: job.package_signature,
    };
    const manifest: InstalledAdapter = { connector_key: job.connector_key, descriptor: job.descriptor, delivery, installed_at: new Date().toISOString() };
    // bundle を先に置く（manifest があるのに bundle が無い状態を作らない）
    await this.store.put(adapterBundleKey(job.connector_key), bundle, "text/javascript");
    await this.store.put(adapterManifestKey(job.connector_key), Buffer.from(JSON.stringify(manifest)), "application/json");
    this.logger.info({ connector_key: job.connector_key, image_digest: job.image_digest, tools: job.descriptor.tools.map((t) => t.name) }, "企業専用Adapterを導入しました");
    return { connector_key: job.connector_key, image_digest: job.image_digest, installed: true };
  }

  async list(): Promise<InstalledAdapter[]> {
    const keys = (await this.store.list("adapters/")).filter((key) => key.endsWith("/manifest.json"));
    const out: InstalledAdapter[] = [];
    for (const key of keys) {
      const raw = await this.store.get(key);
      if (!raw) continue;
      try {
        out.push(installedAdapterSchema.parse(JSON.parse(raw.toString("utf8"))));
      } catch (err) {
        this.logger.warn({ key, err: err instanceof Error ? err.message : String(err) }, "Adapterの導入記録を読めませんでした");
      }
    }
    return out;
  }

  /** 保存後に書き換えられていないか、取り出すたびに digest を確かめる */
  async bundle(connectorKey: string): Promise<Buffer | null> {
    const manifestRaw = await this.store.get(adapterManifestKey(connectorKey));
    if (!manifestRaw) return null;
    const manifest = installedAdapterSchema.parse(JSON.parse(manifestRaw.toString("utf8")));
    const bundle = await this.store.get(adapterBundleKey(connectorKey));
    if (!bundle) return null;
    const digest = `sha256:${createHash("sha256").update(bundle).digest("hex")}`;
    if (digest !== manifest.delivery.image_digest) throw new Error("保存済みAdapter packageのdigestが一致しません");
    return bundle;
  }
}

export type { AdapterDescriptor };
