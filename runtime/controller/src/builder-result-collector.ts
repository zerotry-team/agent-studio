import { execFile } from "node:child_process";
import {
  builderSessionResultSchema,
  type BuilderSessionResult,
  type CollectBuilderSessionResultJob,
} from "@agent-studio/contracts";
import type { Logger } from "./logger.js";

export interface BuilderResultCollector {
  collect(job: CollectBuilderSessionResultJob): Promise<BuilderSessionResult>;
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

const workspaceVolume = (changeSetId: string) => `as-builder-${changeSetId.replaceAll("-", "")}`;

/**
 * Agentのコンテナを信頼せず、同じvolumeをread-onlyで開く使い捨てコンテナから
 * サイズ制限付きの結果JSONだけを回収する。ソース本文やSecretは返さない。
 */
export class DockerBuilderResultCollector implements BuilderResultCollector {
  constructor(
    private readonly image: string,
    private readonly logger: Logger,
    private readonly exec: ExecFileLike = defaultExec,
  ) {}

  async collect(job: CollectBuilderSessionResultJob): Promise<BuilderSessionResult> {
    const { stdout } = await this.exec("docker", [
      "run", "--rm", "--network", "none", "--read-only",
      "--mount", `type=volume,source=${workspaceVolume(job.change_set_id)},target=/workspace,readonly`,
      "--entrypoint", "/bin/sh", this.image,
      "-ceu", "test -f /workspace/outputs/builder-result.json; test \"$(wc -c < /workspace/outputs/builder-result.json)\" -le 1048576; cat /workspace/outputs/builder-result.json",
    ], { env: process.env, timeout: 30_000, maxBuffer: 1024 * 1024 });
    const result = builderSessionResultSchema.parse(JSON.parse(stdout));
    if (result.change_set_id !== job.change_set_id) throw new Error("Builder結果のChange Setが一致しません");
    this.logger.info(
      { session_id: job.session_id, change_set_id: job.change_set_id, commit_sha: result.commit_sha },
      "Self-hosted Builder結果を回収しました",
    );
    return result;
  }
}

export class DisabledBuilderResultCollector implements BuilderResultCollector {
  async collect(_job: CollectBuilderSessionResultJob): Promise<BuilderSessionResult> {
    throw new Error("このRuntimeではSelf-hosted Builder結果の回収が有効になっていません");
  }
}
