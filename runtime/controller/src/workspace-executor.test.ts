import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";
import { DisabledWorkspaceExecutor, DockerWorkspaceExecutor } from "./workspace-executor.js";

const job = {
  type: "builder_workspace" as const,
  job_id: "00000000-0000-4000-8000-000000000001",
  project_id: "00000000-0000-4000-8000-000000000002",
  change_set_id: "00000000-0000-4000-8000-000000000003",
  capability_topic: "past_inquiry_source",
  repository_url: "https://github.com/example/customer-integrations.git",
  base_branch: "main",
  branch: "builder/example/history",
  adapter_path: "integrations/customer-history",
  interface_notes: "顧客IDを受け取り、問い合わせ回数だけを返す",
};

describe("DockerWorkspaceExecutor", () => {
  it("Secretを引数に出さず、隔離volumeの非機微な証跡だけを受理する", async () => {
    const exec = vi.fn(async (_file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      const mount = args[args.indexOf("--mount") + 1]!;
      const source = /source=([^,]+),target=\/result/.exec(mount)?.[1];
      if (!source) throw new Error("result mount not found");
      await writeFile(join(source, "result.json"), JSON.stringify({
        change_set_id: job.change_set_id,
        commit_sha: "a".repeat(40),
        diff_sha256: "b".repeat(64),
        summary: "1ファイルを生成して検証しました",
        changed_files: ["integrations/customer-history/index.ts"],
        tests: [{ command: "yarn test", status: "passed", exit_code: 0 }],
      }));
      expect(args.join(" ")).not.toContain("secret-environment-key");
      expect(options.env.CODEX_API_KEY).toBe("secret-environment-key");
      expect(args).toContain(`type=volume,source=as-builder-${job.change_set_id.replaceAll("-", "")},target=/workspace`);
      return { stdout: "", stderr: "" };
    });
    const executor = new DockerWorkspaceExecutor(
      { image: "agent-studio/session-worker:test", timeoutMinutes: 30 },
      { readEnvironmentKey: async () => "secret-environment-key" },
      createLogger("silent"),
      exec,
    );

    await expect(executor.execute(job)).resolves.toMatchObject({
      change_set_id: job.change_set_id,
      commit_sha: "a".repeat(40),
      changed_files: ["integrations/customer-history/index.ts"],
    });
    expect(exec).toHaveBeenCalledOnce();
  });

  it("無効なRuntimeでは実行しない", async () => {
    await expect(new DisabledWorkspaceExecutor().execute(job)).rejects.toThrow("有効になっていません");
  });

  it("認証失敗時にDocker commandやログ本文をControl Planeへ返さない", async () => {
    const executor = new DockerWorkspaceExecutor(
      { image: "agent-studio/session-worker:test", timeoutMinutes: 30 },
      { readEnvironmentKey: async () => "invalid-job-key" },
      createLogger("silent"),
      async () => {
        throw Object.assign(new Error("docker command with sensitive paths"), { stderr: "HTTP error: 401 Unauthorized" });
      },
    );
    const result = executor.execute(job);
    await expect(result).rejects.toThrow("ジョブ限定認証が無効です");
    await expect(result).rejects.not.toThrow("sensitive paths");
  });
});
