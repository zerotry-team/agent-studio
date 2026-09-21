import { describe, expect, it, vi } from "vitest";
import { DockerGitPublisher } from "./git-publisher.js";
import { createLogger } from "./logger.js";

const job = {
  type: "publish_builder_branch" as const,
  job_id: "00000000-0000-4000-8000-000000000001",
  project_id: "00000000-0000-4000-8000-000000000002",
  change_set_id: "00000000-0000-4000-8000-000000000003",
  connection_id: "00000000-0000-4000-8000-000000000004",
  repository_url: "https://github.com/example/private-adapters.git",
  base_branch: "main",
  branch: "builder/agent/tool/1",
  base_sha: "b".repeat(40),
  commit_sha: "a".repeat(40),
};

describe("DockerGitPublisher", () => {
  it("tokenをstdinだけへ渡し、force/default branchを使わずnamed volumeからpushする", async () => {
    const run = vi.fn(async (args: string[], token: string, env: NodeJS.ProcessEnv) => {
      expect(token).toBe("installation-secret-token");
      expect(args.join(" ")).not.toContain(token);
      expect(JSON.stringify(env)).not.toContain(token);
      expect(args.join(" ")).not.toContain("--force");
      expect(args).toContain(`type=volume,source=as-builder-${job.change_set_id.replaceAll("-", "")},target=/workspace`);
      expect(args).toContain("/tmp:rw,exec,nosuid,size=1048576");
      expect(args).not.toContain("/tmp:rw,noexec,nosuid,size=1048576");
    });
    const publisher = new DockerGitPublisher("publisher:test", {
      gitCredential: async () => ({ username: "x-access-token", token: "installation-secret-token", expires_at: "2099-01-01T00:00:00.000Z", repository_url: job.repository_url }),
    }, createLogger("silent"), undefined, run);
    await expect(publisher.publish(job)).resolves.toEqual({ change_set_id: job.change_set_id, branch: job.branch, base_sha: job.base_sha, head_sha: job.commit_sha, remote_ref: `refs/heads/${job.branch}` });
  });

  it("default branchへのpushを拒否する", async () => {
    const publisher = new DockerGitPublisher("publisher:test", { gitCredential: vi.fn() }, createLogger("silent"), undefined, vi.fn());
    await expect(publisher.publish({ ...job, branch: "main" })).rejects.toThrow("default/protected branch");
  });

  it("Control Plane受理後に呼べるcleanupで対象workspaceだけを破棄する", async () => {
    const remove = vi.fn(async () => undefined);
    const publisher = new DockerGitPublisher(
      "publisher:test",
      { gitCredential: vi.fn() },
      createLogger("silent"),
      undefined,
      vi.fn(),
      remove,
    );
    await publisher.cleanup(job);
    expect(remove).toHaveBeenCalledWith(`as-builder-${job.change_set_id.replaceAll("-", "")}`, process.env);
  });
});
