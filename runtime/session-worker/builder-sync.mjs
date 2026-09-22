// ECS の Builder Session で、Agent が書いた結果（/workspace/outputs/builder-result.json）と
// その commit（git bundle）を Tool Gateway 経由で Runtime Controller へ送る。
// Git の資格情報は持たない。push は Controller が bundle を検証してから行う。
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const SHA_RE = /^[0-9a-f]{40,64}$/;
export const RESULT_REF = "refs/agent-studio/builder-result";
export const MAX_RESULT_BYTES = 1024 * 1024;

async function put(url, token, body, fetchImpl) {
  const res = await fetchImpl(url, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** 結果が変わっていれば bundle → 結果の順に送る。送れたら結果の内容を返す（次回の比較用） */
export async function syncOnce({ workspace, url, token, last, fetchImpl = fetch, git = (args) => run("git", args, { maxBuffer: 1024 * 1024 }), log = () => undefined }) {
  const resultPath = join(workspace, "outputs", "builder-result.json");
  const info = await stat(resultPath).catch(() => null);
  if (!info || !info.isFile() || info.size > MAX_RESULT_BYTES) return last;
  const raw = await readFile(resultPath);
  const text = raw.toString("utf8");
  if (text === last) return last;
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    return last; // 書き込み途中
  }
  if (!SHA_RE.test(String(result?.commit_sha ?? "")) || !SHA_RE.test(String(result?.base_sha ?? ""))) return last;
  const repo = join(workspace, "repo");
  const bundlePath = "/tmp/agent-studio-builder.bundle";
  await git(["-C", repo, "cat-file", "-e", `${result.commit_sha}^{commit}`]);
  await git(["-C", repo, "update-ref", RESULT_REF, result.commit_sha]);
  await git(["-C", repo, "bundle", "create", bundlePath, RESULT_REF, `^${result.base_sha}`]);
  await put(`${url}/bundle`, token, await readFile(bundlePath), fetchImpl);
  await put(`${url}/result`, token, raw, fetchImpl);
  log(`結果を送りました（commit ${String(result.commit_sha).slice(0, 12)}）`);
  return text;
}

async function main() {
  const url = process.env.BUILDER_TRANSFER_URL;
  const token = process.env.BUILDER_TRANSFER_TOKEN;
  const workspace = process.env.BUILDER_WORKSPACE_ROOT || "/workspace";
  if (!url || !token) return;
  const log = (message) => console.error(`[builder-sync] ${message}`);
  let last = null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      last = await syncOnce({ workspace, url, token, last, log });
    } catch (err) {
      log(`送信できませんでした（${err instanceof Error ? err.message : "Error"}）。次の周期で再試行します`);
    } finally {
      running = false;
    }
  };
  setInterval(() => void tick(), Number(process.env.BUILDER_SYNC_INTERVAL_MS || 3000));
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
