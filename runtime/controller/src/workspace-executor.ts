import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builderWorkspaceResultSchema, type BuilderWorkspaceJob, type BuilderWorkspaceResult } from "@agent-studio/contracts";
import type { Logger } from "./logger.js";
import type { ControllerSecrets } from "./secrets.js";

export interface WorkspaceExecutor {
  readonly kind: string;
  /** 安全なジョブ限定認証まで揃い、Control Planeから仕事を受け取ってよいか。 */
  readonly advertisesCapability: boolean;
  execute(job: BuilderWorkspaceJob): Promise<BuilderWorkspaceResult>;
}

export class DisabledWorkspaceExecutor implements WorkspaceExecutor {
  readonly kind = "disabled";
  readonly advertisesCapability = false;

  async execute(_job: BuilderWorkspaceJob): Promise<BuilderWorkspaceResult> {
    throw new Error("このRuntimeではCode Workspace実行が有効になっていません");
  }
}

type ExecFileLike = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFileLike = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr) }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

/**
 * Code生成はControllerプロセスではなく、使い捨てDockerコンテナでだけ実行する。
 * mountへ出すのはソース本文ではなく、差分hash・ファイル名・test結果・commit SHAだけ。
 */
export class DockerWorkspaceExecutor implements WorkspaceExecutor {
  readonly kind = "docker";
  // Environment Keyはexec-server専用。standalone codexへ長期鍵を渡す回避はしない。
  readonly advertisesCapability = false;

  constructor(
    private readonly config: { image: string; network?: string; timeoutMinutes: number },
    private readonly secrets: Pick<ControllerSecrets, "readEnvironmentKey">,
    private readonly logger: Logger,
    private readonly exec: ExecFileLike = defaultExec,
  ) {}

  async execute(job: BuilderWorkspaceJob): Promise<BuilderWorkspaceResult> {
    const environmentKey = await this.secrets.readEnvironmentKey();
    if (!environmentKey) throw new Error("環境キーが無いためCode Workspaceを起動できません");

    const resultDir = await mkdtemp(join(tmpdir(), "agent-studio-workspace-"));
    // コンテナの非rootユーザーが結果ファイルだけを書ける一時領域。処理後は必ず削除する。
    await chmod(resultDir, 0o777);
    const resultPath = join(resultDir, "result.json");
    const args = [
      "run", "--rm",
      "--label", `agentstudio.change_set_id=${job.change_set_id}`,
      "--mount", `type=bind,source=${resultDir},target=/result`,
      "--mount", `type=volume,source=as-builder-${job.change_set_id.replaceAll("-", "")},target=/workspace`,
      "-e", "CODEX_API_KEY",
      "-e", "BUILDER_PROJECT_ID",
      "-e", "BUILDER_CHANGE_SET_ID",
      "-e", "BUILDER_CAPABILITY_TOPIC",
      "-e", "BUILDER_REPOSITORY_URL",
      "-e", "BUILDER_BASE_BRANCH",
      "-e", "BUILDER_BRANCH",
      "-e", "BUILDER_ADAPTER_PATH",
      "-e", "BUILDER_INTERFACE_NOTES",
      "--entrypoint", "/usr/local/bin/workspace-builder-entrypoint",
    ];
    if (this.config.network) args.push("--network", this.config.network);
    args.push(this.config.image);

    try {
      try {
        await this.exec("docker", args, {
          env: {
            ...process.env,
            CODEX_API_KEY: environmentKey,
            BUILDER_PROJECT_ID: job.project_id,
            BUILDER_CHANGE_SET_ID: job.change_set_id,
            BUILDER_CAPABILITY_TOPIC: job.capability_topic,
            BUILDER_REPOSITORY_URL: job.repository_url,
            BUILDER_BASE_BRANCH: job.base_branch,
            BUILDER_BRANCH: job.branch,
            BUILDER_ADAPTER_PATH: job.adapter_path,
            BUILDER_INTERFACE_NOTES: job.interface_notes,
          },
          timeout: this.config.timeoutMinutes * 60_000,
          maxBuffer: 1024 * 1024,
        });
        const raw = JSON.parse(await readFile(resultPath, "utf8")) as unknown;
        const result = builderWorkspaceResultSchema.parse(raw);
        if (result.change_set_id !== job.change_set_id) throw new Error("Code Workspace結果のChange Setが一致しません");
        this.logger.info(
          { change_set_id: job.change_set_id, commit_sha: result.commit_sha, changed_files: result.changed_files.length },
          "Code Workspaceが完了しました",
        );
        return result;
      } catch (cause) {
        const detail = cause && typeof cause === "object" && "stderr" in cause
          ? String((cause as { stderr?: unknown }).stderr ?? "")
          : cause instanceof Error ? cause.message : String(cause);
        if (/401 Unauthorized/i.test(detail)) {
          throw new Error("Code Agentのジョブ限定認証が無効です。長期API Keyや個人のCodex認証は使用せず、Runtime用の短期認証を再発行してください");
        }
        if (/authentication failed|could not read Username|repository not found/i.test(detail)) {
          throw new Error("Git Repositoryをcloneできませんでした。専用Git Connectionの読み取り権限を確認してください");
        }
        if (/timed out|timeout/i.test(detail)) throw new Error("Code Workspaceが制限時間内に完了しませんでした");
        throw new Error("Code Workspaceの隔離実行に失敗しました。Runtimeログでclone・生成・testの失敗箇所を確認してください");
      }
    } finally {
      await rm(resultDir, { recursive: true, force: true });
    }
  }
}
