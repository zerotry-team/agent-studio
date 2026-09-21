import { spawn } from "node:child_process";
import { redactLogText, type GitPublishResult, type PublishBuilderBranchJob } from "@agent-studio/contracts";
import type { StudioApi } from "./studio-client.js";
import type { Logger } from "./logger.js";

export interface GitPublisher {
  publish(job: PublishBuilderBranchJob): Promise<GitPublishResult>;
  /** Control Planeがpush結果を受理したあとにだけ、再送用workspaceを破棄する。 */
  cleanup?(job: PublishBuilderBranchJob): Promise<void>;
}

type RunDocker = (args: string[], token: string, env: NodeJS.ProcessEnv) => Promise<void>;
type RemoveVolume = (name: string, env: NodeJS.ProcessEnv) => Promise<void>;

const defaultRunDocker: RunDocker = (args, token, env) => new Promise((resolve, reject) => {
  const child = spawn("docker", args, { env, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4096); });
  child.once("error", reject);
  child.once("close", (code) => code === 0 ? resolve() : reject(Object.assign(new Error(`git publisher exited ${code}`), { stderr })));
  child.stdin.end(`${token}\n`);
});

const defaultRemoveVolume: RemoveVolume = (name, env) => new Promise((resolve, reject) => {
  const child = spawn("docker", ["volume", "rm", name], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4096); });
  child.once("error", reject);
  child.once("close", (code) => code === 0 ? resolve() : reject(Object.assign(new Error(`workspace cleanup exited ${code}`), { stderr })));
});

const workspaceVolume = (changeSetId: string) => `as-builder-${changeSetId.replaceAll("-", "")}`;

const SCRIPT = String.raw`set -eu
read -r GITHUB_TOKEN
ASKPASS=/tmp/agent-studio-git-askpass
trap 'rm -f "$ASKPASS"' EXIT
cat > "$ASKPASS" <<'EOF'
#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *) printf '%s\n' "$GITHUB_TOKEN" ;;
esac
EOF
chmod 700 "$ASKPASS"
export GITHUB_TOKEN GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0
cd /workspace/repo
test "$(git remote get-url origin)" = "$REPOSITORY_URL"
test "$(git rev-parse HEAD)" = "$COMMIT_SHA"
case "$BRANCH" in builder/*) ;; *) exit 41 ;; esac
git fetch --no-tags origin "$BASE_BRANCH"
test "$(git rev-parse FETCH_HEAD)" = "$BASE_SHA"
git push --porcelain origin "HEAD:refs/heads/$BRANCH"
`;

/** Secretはstdinからtmpfs内askpassへ渡し、argv/env/.git/configには保存しない。 */
export class DockerGitPublisher implements GitPublisher {
  constructor(
    private readonly image: string,
    private readonly studio: Pick<StudioApi, "gitCredential">,
    private readonly logger: Logger,
    private readonly network?: string,
    private readonly runDocker: RunDocker = defaultRunDocker,
    private readonly removeVolume: RemoveVolume = defaultRemoveVolume,
  ) {}

  async publish(job: PublishBuilderBranchJob): Promise<GitPublishResult> {
    if (job.branch === job.base_branch || !job.branch.startsWith("builder/")) throw new Error("default/protected branchへのpushは禁止されています");
    const credential = await this.studio.gitCredential(job.job_id);
    if (credential.repository_url !== job.repository_url) throw new Error("Git資格情報のrepository allowlistが一致しません");
    const args = [
      "run", "--rm", "-i",
      // GitはGIT_ASKPASSを実行ファイルとして起動する。専用の使い捨てpublisher
      // コンテナ内だけ/tmpのexecを許可し、token自体はstdin→環境変数だけに置く。
      "--read-only", "--tmpfs", "/tmp:rw,exec,nosuid,size=1048576",
      "--mount", `type=volume,source=${workspaceVolume(job.change_set_id)},target=/workspace`,
      "-e", "REPOSITORY_URL", "-e", "BASE_BRANCH", "-e", "BRANCH", "-e", "BASE_SHA", "-e", "COMMIT_SHA",
    ];
    if (this.network) args.push("--network", this.network);
    args.push("--entrypoint", "/bin/sh", this.image, "-ceu", SCRIPT);
    try {
      await this.runDocker(args, credential.token, {
        ...process.env,
        REPOSITORY_URL: job.repository_url,
        BASE_BRANCH: job.base_branch,
        BRANCH: job.branch,
        BASE_SHA: job.base_sha,
        COMMIT_SHA: job.commit_sha,
      });
    } catch (error) {
      const detail = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
      const safeDetail = redactLogText(detail).replace(/\s+/g, " ").trim().slice(0, 500);
      if (/non-fast-forward|fetch first/i.test(detail)) throw new Error("専用branchがfast-forwardできません。force pushせず再計画してください");
      if (/Authentication failed|403|denied/i.test(detail)) {
        throw new Error(`GitHub Appでbranchを公開できませんでした${safeDetail ? `: ${safeDetail}` : ""}`);
      }
      throw error;
    }
    this.logger.info({ change_set_id: job.change_set_id, branch: job.branch, head_sha: job.commit_sha }, "Builder branchを公開しました");
    return { change_set_id: job.change_set_id, branch: job.branch, base_sha: job.base_sha, head_sha: job.commit_sha, remote_ref: `refs/heads/${job.branch}` };
  }

  async cleanup(job: PublishBuilderBranchJob): Promise<void> {
    await this.removeVolume(workspaceVolume(job.change_set_id), process.env);
    this.logger.info({ change_set_id: job.change_set_id }, "Builder workspaceを破棄しました");
  }
}

export class DisabledGitPublisher implements GitPublisher {
  async publish(_job: PublishBuilderBranchJob): Promise<GitPublishResult> {
    throw new Error("このRuntimeではGit branch公開が有効になっていません");
  }
}
