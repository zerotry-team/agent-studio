import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { adapterDescriptorSchema, installAdapterJobSchema } from "@agent-studio/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { verifyAdapterPackage } from "./adapters.js";

const TEMPLATE = fileURLToPath(new URL("../../../templates/integration-repo", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();

const ADAPTER = `import http from "node:http";
const base = process.env.DEMO_API_BASE_URL;
const server = http.createServer(async (req, res) => {
  if (req.url === "/health") return res.end("ok");
  if (req.method === "POST" && req.url === "/tools/list_pending_applications") {
    const upstream = await fetch(base + "/applications", { headers: { authorization: "Bearer " + process.env.DEMO_API_TOKEN } });
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(await upstream.json()));
  }
  res.statusCode = 404; res.end("{}");
});
server.listen(Number(process.env.PORT), process.env.HOST || "127.0.0.1");
`;
const TEST = `import test from "node:test";
import assert from "node:assert/strict";
test("形だけのテスト", () => assert.equal(1 + 1, 2));
`;
const SPEC = {
  version: 1,
  connector: { key: "factoring-review", display_name: "審査システム", description: "社内の審査システムの読み取り" },
  tools: [{ name: "list_pending_applications", description: "審査待ちの申込を一覧にします", risk: "read", input_schema: { type: "object", properties: {} }, output_schema: { type: "object" } }],
  execution: { kind: "http", health_endpoint: "/health" },
  network: { outbound_domains: [], private_network_required: true },
  required_connections: [],
};

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

function run(cwd: string, script: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd, env: { ...gitEnv, ...env } });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    child.on("close", (code) => resolve({ code, output }));
  });
}

describe("Integration Repository のテンプレート", () => {
  it("check が通り、deliver が作る Deployment を Runtime の検証が受け付ける", async () => {
    const repo = mkdtempSync(join(tmpdir(), "as-template-"));
    dirs.push(repo);
    cpSync(TEMPLATE, repo, { recursive: true });
    git(repo, "init", "--quiet", "--initial-branch=main");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "template");
    const dir = join(repo, "adapters", "factoring-review");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.mjs"), ADAPTER);
    writeFileSync(join(dir, "index.test.mjs"), TEST);
    writeFileSync(join(dir, "agent-studio.adapter.json"), JSON.stringify(SPEC, null, 2));
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "adapter");
    const commit = git(repo, "rev-parse", "HEAD");

    const checked = await run(repo, "scripts/agent-studio/check.mjs", {});
    expect(checked.output).toContain("検査が通りました");
    expect(checked.code).toBe(0);

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const changeSetId = "00000000-0000-4000-8000-000000000003";
    const runtimeId = "00000000-0000-4000-8000-000000000009";
    let asset: Buffer | null = null;
    let deploymentPayload: Record<string, unknown> | null = null;
    let statusPosted = false;
    const server = createServer(async (req, res) => {
      const body = await readBody(req);
      const url = req.url ?? "";
      res.setHeader("content-type", "application/json");
      if (url === `/repos/example/adapters/commits/${commit}/pulls`) {
        return res.end(JSON.stringify([{ merged_at: "2026-09-22T00:00:00Z", body: `Change Set: ${changeSetId}\n\nRuntime: ${runtimeId}` }]));
      }
      if (url === "/repos/example/adapters/releases") {
        return res.end(JSON.stringify({ id: 1, upload_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/uploads/1/assets{?name,label}` }));
      }
      if (url.startsWith("/uploads/1/assets?name=factoring-review.mjs")) {
        asset = body;
        return res.end(JSON.stringify({ id: 77 }));
      }
      if (url === "/repos/example/adapters/deployments") {
        deploymentPayload = (JSON.parse(body.toString()) as { payload: { agent_studio: Record<string, unknown> } }).payload.agent_studio;
        return res.end(JSON.stringify({ id: 5 }));
      }
      if (url === "/repos/example/adapters/deployments/5/statuses") {
        statusPosted = true;
        return res.end("{}");
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const delivered = await run(repo, "scripts/agent-studio/deliver.mjs", {
        GITHUB_REPOSITORY: "example/adapters",
        GITHUB_SHA: commit,
        GITHUB_TOKEN: "test-token",
        GITHUB_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        ADAPTER_SIGNING_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      });
      expect(delivered.output).toContain("配布しました");
      expect(delivered.code).toBe(0);
    } finally {
      server.close();
    }
    expect(statusPosted).toBe(true);
    const evidence = deploymentPayload as unknown as Record<string, unknown> & { descriptor: unknown; package: { release_asset_id: number } };
    const descriptor = adapterDescriptorSchema.parse(evidence.descriptor);
    expect(descriptor.source.merge_commit).toBe(commit);
    // backend が webhook から作る install_adapter job と同じ形にして、Controller の検証を通す
    const job = installAdapterJobSchema.parse({
      type: "install_adapter",
      job_id: "00000000-0000-4000-8000-000000000001",
      project_id: "00000000-0000-4000-8000-000000000002",
      change_set_id: changeSetId,
      connection_id: "00000000-0000-4000-8000-000000000004",
      repository_url: "https://github.com/example/adapters",
      release_asset_id: evidence.package.release_asset_id,
      connector_key: evidence.connector_key,
      source_commit: commit,
      descriptor_hash: evidence.descriptor_hash,
      contract_hash: evidence.contract_hash,
      image_digest: evidence.image_digest,
      sbom_digest: evidence.sbom_digest,
      package_signature: evidence.package_signature,
      signing_public_key: publicKey.export({ type: "spki", format: "pem" }).toString(),
      descriptor,
    });
    expect(() => verifyAdapterPackage(job, asset!)).not.toThrow();
  }, 60_000);

  it("npm のパッケージを import する Adapter は check で落とす", async () => {
    const repo = mkdtempSync(join(tmpdir(), "as-template-"));
    dirs.push(repo);
    cpSync(TEMPLATE, repo, { recursive: true });
    const dir = join(repo, "adapters", "bad-adapter");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.mjs"), `import axios from "axios";\n`);
    writeFileSync(join(dir, "index.test.mjs"), TEST);
    writeFileSync(join(dir, "agent-studio.adapter.json"), JSON.stringify({ ...SPEC, connector: { ...SPEC.connector, key: "bad-adapter" } }));
    const checked = await run(repo, "scripts/agent-studio/check.mjs", {});
    expect(checked.code).toBe(1);
    expect(checked.output).toContain("axios");
  });
});
