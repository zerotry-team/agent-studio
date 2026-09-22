import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { canonicalJson, type AdapterDescriptor } from "@agent-studio/contracts";
import { describe, expect, it } from "vitest";
import { AdapterInstaller } from "./adapters.js";
import { createLogger } from "./logger.js";
import { MemoryObjectStore } from "./object-store.js";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const bundle = Buffer.from("import http from 'node:http';\n");
  const commit = "c".repeat(40);
  const descriptor: AdapterDescriptor = {
    version: 1,
    connector: { key: "sample-inventory", display_name: "在庫", description: "社内の在庫API" },
    tools: [{ name: "list_low_stock_products", description: "在庫の少ない商品", risk: "read", input_schema: { type: "object", properties: {} }, output_schema: {} }],
    execution: { kind: "http", health_endpoint: "/health" },
    network: { outbound_domains: [], private_network_required: true },
    required_connections: [],
    source: { repository: "example/adapters", merge_commit: commit, build_context: "adapters/sample-inventory" },
  };
  const attestation = {
    source_commit: commit,
    descriptor_hash: sha(canonicalJson(descriptor)),
    contract_hash: sha(canonicalJson(descriptor.tools)),
    image_digest: `sha256:${sha(bundle)}`,
    sbom_digest: `sha256:${"e".repeat(64)}`,
  };
  const signature = sign(null, Buffer.from(canonicalJson(attestation)), privateKey).toString("base64");
  const job = {
    type: "install_adapter" as const,
    job_id: "00000000-0000-4000-8000-000000000001",
    project_id: "00000000-0000-4000-8000-000000000002",
    change_set_id: "00000000-0000-4000-8000-000000000003",
    connection_id: "00000000-0000-4000-8000-000000000004",
    repository_url: "https://github.com/example/adapters",
    release_asset_id: 42,
    connector_key: "sample-inventory",
    ...attestation,
    package_signature: signature,
    signing_public_key: publicKey.export({ type: "spki", format: "pem" }).toString(),
    descriptor,
  };
  return { job, bundle };
}

const studio = { gitCredential: async () => ({ username: "x-access-token" as const, token: "read-only-token-1234567890", expires_at: "2099-01-01T00:00:00.000Z", repository_url: "https://github.com/example/adapters" }) };

describe("AdapterInstaller", () => {
  it("Release の添付を読み取り専用 token で取得し、digest と署名を確かめて保存する", async () => {
    const { job, bundle } = fixture();
    const store = new MemoryObjectStore();
    const requests: Array<{ url: string; auth: string | undefined }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({ url, auth: (init.headers as Record<string, string>).authorization });
      return new Response(new Uint8Array(bundle), { status: 200 });
    }) as unknown as typeof fetch;
    const installer = new AdapterInstaller(store, studio, createLogger("silent"), fetchImpl);
    await expect(installer.install(job)).resolves.toEqual({ connector_key: "sample-inventory", image_digest: job.image_digest, installed: true });
    expect(requests[0]?.url).toBe("https://api.github.com/repos/example/adapters/releases/assets/42");
    expect(requests[0]?.auth).toBe("Bearer read-only-token-1234567890");
    const listed = await installer.list();
    expect(listed.map((item) => item.delivery.image_digest)).toEqual([job.image_digest]);
    expect((await installer.bundle("sample-inventory"))?.equals(bundle)).toBe(true);
  });

  it("中身が署名と違えば保存しない", async () => {
    const { job } = fixture();
    const store = new MemoryObjectStore();
    const fetchImpl = (async () => new Response("tampered", { status: 200 })) as unknown as typeof fetch;
    const installer = new AdapterInstaller(store, studio, createLogger("silent"), fetchImpl);
    await expect(installer.install(job)).rejects.toThrow("digest");
    expect(await store.list("adapters/")).toEqual([]);
  });

  it("別の鍵の署名は受け付けない", async () => {
    const { job, bundle } = fixture();
    const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    const fetchImpl = (async () => new Response(new Uint8Array(bundle), { status: 200 })) as unknown as typeof fetch;
    const installer = new AdapterInstaller(new MemoryObjectStore(), studio, createLogger("silent"), fetchImpl);
    await expect(installer.install({ ...job, signing_public_key: other })).rejects.toThrow("署名");
  });
});
