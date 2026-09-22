// Agent Studio の Adapter の検査・配布で共通に使う処理（Node の組み込みモジュールだけを使う）
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const ADAPTERS_DIR = "adapters";
const KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOOL_RE = /^[a-z][a-z0-9_]{0,63}$/;
const RISKS = new Set(["read", "write", "external_send", "financial", "destructive"]);
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** Agent Studio（packages/contracts の canonicalJson）と同じ正規化: key を並べ替え、undefined を除く */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function listAdapters(root = process.cwd()) {
  const dir = join(root, ADAPTERS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

/** agent-studio.adapter.json を読み、形式の誤りを日本語で返す */
export function readAdapter(key, root = process.cwd()) {
  const dir = join(root, ADAPTERS_DIR, key);
  const errors = [];
  if (!KEY_RE.test(key)) errors.push(`${key}: ディレクトリ名は英小文字・数字・ハイフンにしてください`);
  for (const file of ["agent-studio.adapter.json", "index.mjs", "index.test.mjs"]) {
    if (!existsSync(join(dir, file))) errors.push(`${key}: ${file} がありません`);
  }
  if (errors.length) return { errors };
  let spec;
  try {
    spec = JSON.parse(readFileSync(join(dir, "agent-studio.adapter.json"), "utf8"));
  } catch {
    return { errors: [`${key}: agent-studio.adapter.json が JSON として読めません`] };
  }
  const allowed = new Set(["version", "connector", "tools", "execution", "network", "required_connections"]);
  for (const name of Object.keys(spec)) if (!allowed.has(name)) errors.push(`${key}: agent-studio.adapter.json に使えない項目 ${name} があります（source は CI が付けます）`);
  if (spec.version !== 1) errors.push(`${key}: version は 1 にしてください`);
  if (spec.connector?.key !== key) errors.push(`${key}: connector.key をディレクトリ名と同じにしてください`);
  if (!spec.connector?.display_name || !spec.connector?.description) errors.push(`${key}: connector.display_name と description が必要です`);
  if (!Array.isArray(spec.tools) || spec.tools.length === 0) errors.push(`${key}: tools が空です`);
  const names = new Set();
  for (const tool of Array.isArray(spec.tools) ? spec.tools : []) {
    const label = `${key}/${tool?.name ?? "?"}`;
    if (!TOOL_RE.test(tool?.name ?? "")) errors.push(`${label}: Tool 名は英小文字・数字・_ にしてください`);
    if (names.has(tool?.name)) errors.push(`${label}: Tool 名が重複しています`);
    names.add(tool?.name);
    if (!tool?.description) errors.push(`${label}: description が必要です`);
    if (!RISKS.has(tool?.risk)) errors.push(`${label}: risk が正しくありません`);
    if (tool?.input_schema?.type !== "object") errors.push(`${label}: input_schema.type は object にしてください`);
    if (!("output_schema" in (tool ?? {}))) errors.push(`${label}: output_schema が必要です`);
    const extra = Object.keys(tool ?? {}).filter((name) => !["name", "description", "risk", "input_schema", "output_schema"].includes(name));
    if (extra.length) errors.push(`${label}: 使えない項目 ${extra.join(", ")} があります`);
  }
  if (spec.execution?.kind !== "http" || !String(spec.execution?.health_endpoint ?? "").startsWith("/")) {
    errors.push(`${key}: execution は { "kind": "http", "health_endpoint": "/health" } の形にしてください`);
  }
  if (!Array.isArray(spec.network?.outbound_domains) || typeof spec.network?.private_network_required !== "boolean") {
    errors.push(`${key}: network.outbound_domains と network.private_network_required が必要です`);
  }
  if (!Array.isArray(spec.required_connections)) errors.push(`${key}: required_connections は配列にしてください`);
  const bundlePath = join(dir, "index.mjs");
  if (statSync(bundlePath).size > MAX_BUNDLE_BYTES) errors.push(`${key}: index.mjs が大きすぎます`);
  const source = readFileSync(bundlePath, "utf8");
  errors.push(...checkImports(key, source));
  return { errors, spec, bundlePath };
}

/** index.mjs が import してよいのは node: の組み込みモジュールだけ */
export function checkImports(key, source) {
  const errors = [];
  const specifiers = [
    ...source.matchAll(/\bimport\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g),
    ...source.matchAll(/\bexport\s+[^'"]*?\s+from\s+["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
  for (const specifier of specifiers) {
    if (!specifier.startsWith("node:")) errors.push(`${key}: index.mjs で ${specifier} を import しています（node: の組み込みモジュールだけ使えます）`);
  }
  if (/\bimport\s*\(\s*[^"'\s)]/.test(source)) errors.push(`${key}: 動的な import は使えません`);
  if (/\brequire\s*\(/.test(source)) errors.push(`${key}: require は使えません`);
  if (/node:child_process|node:worker_threads|node:vm\b/.test(source)) errors.push(`${key}: child_process / worker_threads / vm は使えません`);
  return errors;
}

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "秘密鍵"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS のアクセスキー"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "GitHub のトークン"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, "API キー"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/, "Slack のトークン"],
  [/Bearer\s+[A-Za-z0-9._~+/-]{24,}={0,2}/, "Bearer トークン"],
];

/** 秘密情報の書き込みを探す（見つかった場所と種類だけを返し、値は出さない） */
export function scanSecrets(root = process.cwd()) {
  const findings = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && statSync(full).size < 2 * 1024 * 1024) {
        const text = readFileSync(full, "utf8");
        for (const [pattern, label] of SECRET_PATTERNS) {
          if (pattern.test(text)) findings.push(`${relative(root, full)}: ${label}のような値があります`);
        }
      }
    }
  };
  if (existsSync(join(root, ADAPTERS_DIR))) walk(join(root, ADAPTERS_DIR));
  return findings;
}
