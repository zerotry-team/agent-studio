import { describe, expect, it, vi } from "vitest";
import { DockerBuilderResultCollector } from "./builder-result-collector.js";
import { createLogger } from "./logger.js";

const job = {
  type: "collect_builder_session_result" as const,
  job_id: "20000000-0000-4000-8000-000000000001",
  session_id: "00000000-0000-4000-8000-000000000001",
  change_set_id: "40000000-0000-4000-8000-000000000001",
};

const result = {
  change_set_id: job.change_set_id,
  base_sha: "a".repeat(40),
  commit_sha: "b".repeat(40),
  diff_sha256: "c".repeat(64),
  summary: "adapterを追加しました",
  changed_files: ["integrations/company-a/index.ts"],
  tests: [{ command: "yarn test", status: "passed" as const, exit_code: 0 }],
};

describe("DockerBuilderResultCollector", () => {
  it("隔離volumeをread-onlyで開き、schema検証済み結果だけを返す", async () => {
    const exec = vi.fn(async () => ({ stdout: JSON.stringify(result), stderr: "" }));
    const collector = new DockerBuilderResultCollector("session-worker:test", createLogger("silent"), exec);

    await expect(collector.collect(job)).resolves.toEqual(result);
    expect(exec).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining([
        "--network", "none", "--read-only",
        "--mount", "type=volume,source=as-builder-40000000000040008000000000000001,target=/workspace,readonly",
      ]),
      expect.objectContaining({ timeout: 30_000, maxBuffer: 1024 * 1024 }),
    );
  });

  it("別Change Setの結果は拒否する", async () => {
    const exec = vi.fn(async () => ({ stdout: JSON.stringify({ ...result, change_set_id: "50000000-0000-4000-8000-000000000001" }), stderr: "" }));
    const collector = new DockerBuilderResultCollector("session-worker:test", createLogger("silent"), exec);
    await expect(collector.collect(job)).rejects.toThrow("Change Setが一致しません");
  });
});
