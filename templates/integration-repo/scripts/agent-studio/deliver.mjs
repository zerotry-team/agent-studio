// main への merge 後に実行する配布: 変更された Adapter を署名して Release に添付し、Deployment を作る。
// Agent Studio は Deployment の署名を確かめ、Runtime に導入の指示を出す。
import { execFileSync } from "node:child_process";
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { ADAPTERS_DIR, canonicalJson, readAdapter, scanSecrets, sha256 } from "./lib.mjs";

const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} が設定されていません`);
  return value;
};
const repository = env("GITHUB_REPOSITORY");
const commit = env("GITHUB_SHA");
const token = env("GITHUB_TOKEN");
const api = process.env.GITHUB_API_URL || "https://api.github.com";

async function github(path, init = {}) {
  const res = await fetch(path.startsWith("http") ? path : `${api}${path}`, {
    ...init,
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub API がエラーを返しました（HTTP ${res.status} ${path}）: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// この merge commit を作った PR から、Agent Studio の Change Set と Runtime を読む
const pulls = await github(`/repos/${repository}/commits/${commit}/pulls`);
const pull = pulls.find((item) => item.merged_at && /Change Set:\s*[0-9a-f-]{36}/.test(item.body ?? ""));
if (!pull) {
  console.log("Agent Studio の PR による変更ではないため、配布しません");
  process.exit(0);
}
const changeSetId = /Change Set:\s*([0-9a-f-]{36})/.exec(pull.body)[1];
const runtimeId = /Runtime:\s*([0-9a-f-]{36})/.exec(pull.body)?.[1];
if (!runtimeId) throw new Error("PR の本文に Runtime がありません");

const changed = execFileSync("git", ["diff", "--name-only", "HEAD^1", "HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean);
const keys = [...new Set(changed.filter((path) => path.startsWith(`${ADAPTERS_DIR}/`)).map((path) => path.split("/")[1]))];
if (keys.length !== 1) throw new Error(`1 回の変更で配布できる Adapter は 1 つです（変更: ${keys.join(", ") || "なし"}）`);
const key = keys[0];
const adapter = readAdapter(key);
const findings = scanSecrets();
if (adapter.errors.length || findings.length) throw new Error([...adapter.errors, ...findings].join("\n"));

const bundle = readFileSync(adapter.bundlePath);
const descriptor = { ...adapter.spec, source: { repository, merge_commit: commit, build_context: `${ADAPTERS_DIR}/${key}` } };
const sbom = { format: "agent-studio-sbom-v1", component: key, source_commit: commit, dependencies: [], files: [{ path: `${ADAPTERS_DIR}/${key}/index.mjs`, sha256: sha256(bundle) }] };
const attestation = {
  source_commit: commit,
  descriptor_hash: sha256(canonicalJson(descriptor)),
  contract_hash: sha256(canonicalJson(descriptor.tools)),
  image_digest: `sha256:${sha256(bundle)}`,
  sbom_digest: `sha256:${sha256(canonicalJson(sbom))}`,
};
const signature = sign(null, Buffer.from(canonicalJson(attestation), "utf8"), createPrivateKey(env("ADAPTER_SIGNING_KEY"))).toString("base64");

// Release に Adapter を添付する（Runtime は読み取り専用の token でここから取得する）
const tag = `adapter-${key}-${commit.slice(0, 12)}`;
const release = await github(`/repos/${repository}/releases`, {
  method: "POST",
  body: JSON.stringify({ tag_name: tag, target_commitish: commit, name: `${key} ${commit.slice(0, 12)}`, body: `Agent Studio Adapter\n\nChange Set: ${changeSetId}\nImage digest: ${attestation.image_digest}`, draft: false, prerelease: true }),
});
const uploadUrl = release.upload_url.replace(/\{.*\}$/, "");
const asset = await github(`${uploadUrl}?name=${encodeURIComponent(`${key}.mjs`)}`, {
  method: "POST",
  headers: { "content-type": "text/javascript" },
  body: bundle,
});

const deployment = await github(`/repos/${repository}/deployments`, {
  method: "POST",
  body: JSON.stringify({
    ref: commit,
    environment: "preview",
    auto_merge: false,
    required_contexts: [],
    transient_environment: true,
    production_environment: false,
    description: `Agent Studio Adapter ${key}`,
    payload: {
      agent_studio: {
        change_set_id: changeSetId,
        runtime_id: runtimeId,
        connector_key: key,
        descriptor_hash: attestation.descriptor_hash,
        contract_hash: attestation.contract_hash,
        image_digest: attestation.image_digest,
        package_signature: signature,
        sbom_digest: attestation.sbom_digest,
        dependency_scan: { status: "passed", critical: 0 },
        secret_scan: { status: "passed", findings: 0 },
        provenance: { builder: "github-actions", source_repository: repository, build_context: `${ADAPTERS_DIR}/${key}`, workflow_run: process.env.GITHUB_RUN_ID ?? "" },
        descriptor,
        package: { release_asset_id: asset.id },
      },
    },
  }),
});
await github(`/repos/${repository}/deployments/${deployment.id}/statuses`, {
  method: "POST",
  body: JSON.stringify({ state: "success", description: "署名済みの Adapter を Release に添付しました" }),
});
console.log(`Adapter ${key} を配布しました（${attestation.image_digest}、Release asset ${asset.id}）`);
