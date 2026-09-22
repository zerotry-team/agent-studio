import { spawnSync } from "node:child_process";
import { generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./api.js";
import { configDir } from "./config.js";

/** リポジトリ直下の templates/integration-repo（src からも dist からも 3 つ上） */
export const TEMPLATE_DIR = fileURLToPath(new URL("../../../templates/integration-repo", import.meta.url));

type Run = (command: string, args: string[], options?: { cwd?: string; input?: string }) => { status: number | null; stdout: string; stderr: string };

const defaultRun: Run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: options.cwd, input: options.input, encoding: "utf8" });
  if (result.error) return { status: 127, stdout: "", stderr: result.error.message };
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Adapter package の署名鍵。秘密鍵はこの PC の設定ディレクトリと GitHub Actions の secret にだけ置く */
export function ensureSigningKey(repo: string): { publicKey: string; privateKeyPath: string; created: boolean } {
  const dir = join(configDir(), "signing-keys");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const privateKeyPath = join(dir, `${repo.replace("/", "-")}.pem`);
  if (existsSync(privateKeyPath)) {
    const publicKey = createPublicKey(createPrivateKey(readFileSync(privateKeyPath, "utf8"))).export({ type: "spki", format: "pem" }).toString();
    return { publicKey, privateKeyPath, created: false };
  }
  const pair = generateKeyPairSync("ed25519");
  writeFileSync(privateKeyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
  return { publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), privateKeyPath, created: true };
}

/** GitHub Actions の secret ADAPTER_SIGNING_KEY に秘密鍵を登録する（gh CLI の認証を使う）。できなければ false */
export function storeSigningSecret(repo: string, privateKeyPath: string, run: Run = defaultRun): boolean {
  const result = run("gh", ["secret", "set", "ADAPTER_SIGNING_KEY", "--repo", repo], { input: readFileSync(privateKeyPath, "utf8") });
  return result.status === 0;
}

/**
 * Integration Repository（Builder が Adapter を置く private repository）を用意する。
 * - 無ければ gh CLI で private repository を作る
 * - テンプレート（CI・検査/配布スクリプト・AGENTS.md）が無ければ main に入れる
 * - 署名鍵を作り、GitHub Actions の secret に登録する
 * GitHub App には workflow を書き換える権限を渡さないため、CI の初期設定は利用者の gh の認証で行う。
 */
export function initIntegrationRepo(repo: string, run: Run = defaultRun, log: (message: string) => void = console.log): { publicKey: string } {
  if (!REPO_RE.test(repo)) throw new CliError("リポジトリは owner/name の形で指定してください");
  if (run("gh", ["auth", "status"]).status !== 0) {
    throw new CliError("GitHub CLI（gh）でログインしていません。`gh auth login` を実行してからやり直してください");
  }
  const exists = run("gh", ["repo", "view", repo, "--json", "name"]).status === 0;
  if (!exists) {
    const created = run("gh", ["repo", "create", repo, "--private", "--description", "Agent Studio が作る社内システム用 Adapter"]);
    if (created.status !== 0) throw new CliError(`リポジトリを作成できませんでした: ${created.stderr.trim().slice(0, 300)}`);
    log(`private リポジトリ ${repo} を作成しました。`);
  }

  const work = mkdtempSync(join(tmpdir(), "agent-studio-repo-"));
  try {
    const dir = join(work, "repo");
    const cloned = run("gh", ["repo", "clone", repo, dir]);
    if (cloned.status !== 0) throw new CliError(`リポジトリを取得できませんでした: ${cloned.stderr.trim().slice(0, 300)}`);
    const git = (...args: string[]) => run("git", args, { cwd: dir });
    const empty = git("rev-parse", "--verify", "HEAD").status !== 0;
    if (empty) git("checkout", "-b", "main");
    if (existsSync(join(dir, "scripts", "agent-studio", "deliver.mjs"))) {
      log("リポジトリには Agent Studio のテンプレートが入っています。");
    } else {
      // 既存のファイルは上書きしない
      cpSync(TEMPLATE_DIR, dir, { recursive: true, force: false, errorOnExist: false });
      git("add", "-A");
      const committed = git("-c", "user.name=Agent Studio CLI", "-c", "user.email=cli@agent-studio.invalid", "commit", "-m", "Agent Studio の Adapter 用テンプレートを追加");
      if (committed.status !== 0) throw new CliError(`テンプレートを commit できませんでした: ${committed.stderr.trim().slice(0, 300)}`);
      const branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.trim() || "main";
      const pushed = git("push", "origin", `HEAD:${branch}`);
      if (pushed.status !== 0) {
        const hint = /workflow/i.test(pushed.stderr) ? "（CI の定義を push するには `gh auth refresh -s workflow` で権限を追加してください）" : "";
        throw new CliError(`テンプレートを push できませんでした${hint}: ${pushed.stderr.trim().slice(0, 300)}`);
      }
      log(`テンプレート（CI・検査・配布・AGENTS.md）を ${branch} に追加しました。`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const key = ensureSigningKey(repo);
  if (storeSigningSecret(repo, key.privateKeyPath, run)) {
    log("署名用の秘密鍵を GitHub Actions の secret ADAPTER_SIGNING_KEY に登録しました。");
  } else {
    log(`署名用の秘密鍵（${key.privateKeyPath}）を GitHub Actions の secret ADAPTER_SIGNING_KEY に登録してください:`);
    log(`  gh secret set ADAPTER_SIGNING_KEY --repo ${repo} < ${key.privateKeyPath}`);
  }
  return { publicKey: key.publicKey };
}
