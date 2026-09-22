// Session Worker の作業領域（/workspace/outputs、/workspace/generated_images）のファイルを
// Tool Gateway 経由で Run の成果物として送る。Self-hosted では OpenAI の Artifacts API から
// ファイルを取り出せないため、Runtime 側で回収する。
// 送れるのはこの Session の成果物だけ（token は Session ごと）。認証情報や AWS の権限は持たない。
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export const DIRECTORIES = ["outputs", "generated_images"];
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 50;

/** 送る対象のファイル（/workspace からの相対パス）を列挙する。symlink・隠しファイル・上限超えは送らない */
export async function listOutputFiles(workspace) {
  const files = [];
  const walk = async (dir, depth) => {
    if (depth > 5 || files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MAX_FILES) return;
      if (entry.name.startsWith(".") || /[\\\0\r\n]/.test(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile()) {
        const info = await lstat(full).catch(() => null);
        if (!info || !info.isFile() || info.size > MAX_FILE_BYTES) continue;
        files.push({ path: relative(workspace, full).split("\\").join("/"), full, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
  };
  for (const name of DIRECTORIES) await walk(join(workspace, name), 0);
  return files;
}

/** 変わったファイルだけを送る。送れなかったものは次の周期でもう一度送る */
export async function syncOnce({ workspace, url, token, sent, fetchImpl = fetch, log = () => undefined }) {
  for (const file of await listOutputFiles(workspace)) {
    const key = `${file.size}:${file.mtimeMs}`;
    if (sent.get(file.path) === key) continue;
    const body = await readFile(file.full).catch(() => null);
    if (!body || body.byteLength > MAX_FILE_BYTES) continue;
    const sha256 = createHash("sha256").update(body).digest("hex");
    try {
      const res = await fetchImpl(`${url}/${file.path.split("/").map(encodeURIComponent).join("/")}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "x-content-sha256": sha256 },
        body,
        signal: AbortSignal.timeout(120_000),
      });
      // 安全検査で拒否されたもの（400）も、同じ内容なら送り直さない
      if (res.ok || res.status === 400) sent.set(file.path, key);
      log(`${file.path}: HTTP ${res.status}`);
    } catch (err) {
      log(`${file.path}: 送信できませんでした（${err instanceof Error ? err.name : "Error"}）`);
    }
  }
}

async function main() {
  const url = process.env.SESSION_OUTPUTS_URL;
  const token = process.env.SESSION_OUTPUTS_TOKEN;
  const workspace = process.env.WORKSPACE_DIRECTORY || "/workspace";
  if (!url || !token) return;
  const intervalMs = Number(process.env.SESSION_OUTPUTS_INTERVAL_MS || 3000);
  const sent = new Map();
  const log = (message) => console.error(`[outputs-sync] ${message}`);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await syncOnce({ workspace, url, token, sent, log });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  const stop = async () => {
    clearInterval(timer);
    // 停止前に最後の変更を送る（止まるまでの猶予内で）
    while (running) await new Promise((resolve) => setTimeout(resolve, 100));
    await syncOnce({ workspace, url, token, sent, log }).catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
