import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  builderSessionResultSchema,
  redactLogText,
  type BuilderSessionResult,
  type BuilderSessionWorkspace,
  type CollectBuilderSessionResultJob,
  type GitPublishResult,
  type PublishBuilderBranchJob,
} from "@agent-studio/contracts";
import type { BuilderResultCollector } from "./builder-result-collector.js";
import { builderBundleKey, builderInputKey, builderResultKey, parseBundleHeader } from "./builder-transfer.js";
import type { GitPublisher } from "./git-publisher.js";
import type { Logger } from "./logger.js";
import type { ObjectStore } from "./object-store.js";
import type { StudioApi } from "./studio-client.js";

export type RunCommand = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<{ stdout: string }>;

export const runCommand: RunCommand = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-1024 * 1024); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8192); });
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 120_000);
  child.once("error", (err) => { clearTimeout(timer); reject(err); });
  child.once("close", (code) => {
    clearTimeout(timer);
    if (code === 0) resolve({ stdout });
    else reject(Object.assign(new Error(`${command} ${args[0] ?? ""} が終了コード ${code} で失敗しました`), { stderr }));
  });
});

const ASKPASS = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *) printf '%s\\n' "$AGENT_STUDIO_GIT_TOKEN" ;;
esac
`;

/**
 * Controller の中だけで git を動かす環境。token は子プロセスの環境変数と tmp の askpass だけに置き、
 * argv・.git/config・ログには出さない。hook と外部の git 設定は読まない。
 */
async function gitEnvironment(workdir: string, token: string): Promise<NodeJS.ProcessEnv> {
  const askpass = join(workdir, "askpass.sh");
  await writeFile(askpass, ASKPASS, { mode: 0o700 });
  await chmod(askpass, 0o700);
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: workdir,
    GIT_ASKPASS: askpass,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    AGENT_STUDIO_GIT_TOKEN: token,
  };
}

const SAFE_GIT = ["-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.file.allow=always"];

function describeGitError(error: unknown): string {
  const detail = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
  return redactLogText(detail).replace(/\s+/g, " ").trim().slice(0, 500);
}

/**
 * ECS（Fargate）で Builder Session を動かすための作業領域の受け渡し。
 * - 準備: Controller が読み取り専用 token で clone し、Session Worker へ tar で渡す（Worker に token を渡さない）
 * - 回収: Worker が送った結果 JSON と git bundle を検証する（git は実行しない）
 * - 公開: 新しい repo に bundle を取り込み、書き込み token で builder/* branch だけへ push する
 *   （Worker が書いた .git の設定・hook は Controller で一切読まない）
 */
export class EcsBuilderWorkspaces implements BuilderResultCollector, GitPublisher {
  constructor(
    private readonly store: ObjectStore,
    private readonly studio: Pick<StudioApi, "gitCredential">,
    private readonly logger: Logger,
    private readonly run: RunCommand = runCommand,
    private readonly options: { collectTimeoutMs?: number; pollIntervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  /** start_session の前に呼ぶ。再配送では準備済みの作業領域をそのまま使う */
  async prepare(jobId: string, workspace: BuilderSessionWorkspace): Promise<void> {
    // 前回の試行の結果を回収しないよう、結果は毎回消す
    await this.store.delete([builderResultKey(workspace.change_set_id), builderBundleKey(workspace.change_set_id)]);
    if (await this.store.get(builderInputKey(workspace.change_set_id))) return;
    const credential = await this.studio.gitCredential(jobId);
    if (credential.repository_url !== workspace.repository_url) throw new Error("Git資格情報のrepository allowlistが一致しません");
    const dir = await mkdtemp(join(tmpdir(), "as-builder-prepare-"));
    try {
      const env = await gitEnvironment(dir, credential.token);
      const root = join(dir, "workspace");
      await mkdir(join(root, "outputs"), { recursive: true });
      const repo = join(root, "repo");
      try {
        await this.run("git", [...SAFE_GIT, "clone", "--quiet", "--depth", "1", "--single-branch", "--branch", workspace.base_branch, workspace.repository_url, repo], { env, timeoutMs: 180_000 });
      } catch (error) {
        throw new Error(`Repositoryをcloneできませんでした${describeGitError(error) ? `: ${describeGitError(error)}` : ""}`);
      }
      const { stdout } = await this.run("git", [...SAFE_GIT, "-C", repo, "rev-parse", "HEAD"], { env });
      const baseSha = stdout.trim();
      if (!/^[0-9a-f]{40,64}$/.test(baseSha)) throw new Error("基点commitを確認できませんでした");
      await this.run("git", [...SAFE_GIT, "-C", repo, "switch", "--quiet", "-c", workspace.branch], { env });
      await this.run("git", [...SAFE_GIT, "-C", repo, "config", "user.name", "Agent Studio Builder"], { env });
      await this.run("git", [...SAFE_GIT, "-C", repo, "config", "user.email", "builder@agent-studio.invalid"], { env });
      await writeFile(join(root, ".builder-base-sha"), `${baseSha}\n`, { mode: 0o444 });
      const archive = join(dir, "input.tar.gz");
      await this.run("tar", ["-czf", archive, "-C", root, "repo", "outputs", ".builder-base-sha"], { env, timeoutMs: 120_000 });
      await this.store.put(builderInputKey(workspace.change_set_id), await readFile(archive), "application/gzip");
      this.logger.info({ change_set_id: workspace.change_set_id, base_sha: baseSha }, "Builder の作業領域を準備しました");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async collect(job: CollectBuilderSessionResultJob): Promise<BuilderSessionResult> {
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    // Control Plane は 60 秒で回収を諦めるため、それより前に理由付きで失敗を返す
    const deadline = Date.now() + (this.options.collectTimeoutMs ?? 45_000);
    let raw: Buffer | null = null;
    // 結果は Worker が commit の後に送る。turn 完了の直後は届いていないことがあるので少し待つ
    for (;;) {
      raw = await this.store.get(builderResultKey(job.change_set_id));
      if (raw || Date.now() >= deadline) break;
      await sleep(this.options.pollIntervalMs ?? 2_000);
    }
    if (!raw) throw new Error("Builderの結果（/workspace/outputs/builder-result.json）がRuntimeに届いていません");
    if (raw.byteLength > 1024 * 1024) throw new Error("Builderの結果が大きすぎます");
    const result = builderSessionResultSchema.parse(JSON.parse(raw.toString("utf8")));
    if (result.change_set_id !== job.change_set_id) throw new Error("Builder結果のChange Setが一致しません");
    const bundle = await this.store.get(builderBundleKey(job.change_set_id));
    if (!bundle) throw new Error("Builderのcommit（git bundle）がRuntimeに届いていません");
    const header = parseBundleHeader(bundle);
    if (!header.refs.some((ref) => ref.sha === result.commit_sha)) throw new Error("git bundleのcommitがBuilder結果のcommit_shaと一致しません");
    if (!header.prerequisites.includes(result.base_sha)) throw new Error("git bundleの基点がBuilder結果のbase_shaと一致しません");
    this.logger.info({ session_id: job.session_id, change_set_id: job.change_set_id, commit_sha: result.commit_sha }, "Self-hosted Builder結果を回収しました");
    return result;
  }

  async publish(job: PublishBuilderBranchJob): Promise<GitPublishResult> {
    if (job.branch === job.base_branch || !job.branch.startsWith("builder/")) throw new Error("default/protected branchへのpushは禁止されています");
    const bundle = await this.store.get(builderBundleKey(job.change_set_id));
    if (!bundle) throw new Error("Builderのcommit（git bundle）が見つかりません");
    const header = parseBundleHeader(bundle);
    const source = header.refs.find((ref) => ref.sha === job.commit_sha && /^refs\/[A-Za-z0-9._/-]+$/.test(ref.ref) && !ref.ref.includes(".."));
    if (!source) throw new Error("git bundleのcommitが公開対象と一致しません");
    const credential = await this.studio.gitCredential(job.job_id);
    if (credential.repository_url !== job.repository_url) throw new Error("Git資格情報のrepository allowlistが一致しません");
    const dir = await mkdtemp(join(tmpdir(), "as-builder-publish-"));
    try {
      const env = await gitEnvironment(dir, credential.token);
      const repo = join(dir, "repo");
      const bundlePath = join(dir, "repo.bundle");
      await writeFile(bundlePath, bundle);
      const git = (args: string[], timeoutMs = 120_000) => this.run("git", [...SAFE_GIT, "-C", repo, ...args], { env, timeoutMs });
      await this.run("git", [...SAFE_GIT, "init", "--quiet", repo], { env });
      await git(["remote", "add", "origin", job.repository_url]);
      try {
        await git(["fetch", "--quiet", "--no-tags", "--depth", "1", "origin", `refs/heads/${job.base_branch}`], 180_000);
        const base = (await git(["rev-parse", "FETCH_HEAD"])).stdout.trim();
        if (base !== job.base_sha) throw new Error("基点branchが作業開始時から更新されています。再計画してください");
        await git(["bundle", "verify", "--quiet", bundlePath]);
        await git(["fetch", "--quiet", "--no-tags", bundlePath, `${source.ref}:refs/heads/${job.branch}`]);
        const head = (await git(["rev-parse", `refs/heads/${job.branch}`])).stdout.trim();
        if (head !== job.commit_sha) throw new Error("取り込んだcommitが公開対象と一致しません");
        await git(["push", "--porcelain", "origin", `refs/heads/${job.branch}:refs/heads/${job.branch}`], 180_000);
      } catch (error) {
        const detail = describeGitError(error);
        if (/non-fast-forward|fetch first/i.test(detail)) throw new Error("専用branchがfast-forwardできません。force pushせず再計画してください");
        if (/Authentication failed|403|denied/i.test(detail)) throw new Error(`GitHub Appでbranchを公開できませんでした${detail ? `: ${detail}` : ""}`);
        throw error instanceof Error && !detail ? error : new Error(`${error instanceof Error ? error.message : "git操作に失敗しました"}${detail ? `: ${detail}` : ""}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    this.logger.info({ change_set_id: job.change_set_id, branch: job.branch, head_sha: job.commit_sha }, "Builder branchを公開しました");
    return { change_set_id: job.change_set_id, branch: job.branch, base_sha: job.base_sha, head_sha: job.commit_sha, remote_ref: `refs/heads/${job.branch}` };
  }

  async cleanup(job: PublishBuilderBranchJob): Promise<void> {
    await this.store.delete([builderInputKey(job.change_set_id), builderResultKey(job.change_set_id), builderBundleKey(job.change_set_id)]);
    this.logger.info({ change_set_id: job.change_set_id }, "Builder workspaceを破棄しました");
  }
}
