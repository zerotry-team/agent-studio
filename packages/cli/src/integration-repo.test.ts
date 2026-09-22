import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initIntegrationRepo } from "./integration-repo.js";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "as-cli-repo-"));
  dirs.push(dir);
  return dir;
};
beforeEach(() => {
  process.env.AGENT_STUDIO_CONFIG_DIR = temp();
});
afterEach(() => {
  delete process.env.AGENT_STUDIO_CONFIG_DIR;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

describe("initIntegrationRepo", () => {
  it("private repository を作り、テンプレートを main に入れ、署名鍵を Actions の secret に登録する", () => {
    const remote = join(temp(), "remote.git");
    const calls: string[] = [];
    let secret = "";
    const run = (command: string, args: string[], options: { cwd?: string; input?: string } = {}) => {
      calls.push(`${command} ${args.slice(0, 2).join(" ")}`);
      if (command === "gh") {
        if (args[0] === "auth") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "repo" && args[1] === "view") return { status: existsSync(remote) ? 0 : 1, stdout: "", stderr: "" };
        if (args[0] === "repo" && args[1] === "create") {
          spawnSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote], { env: gitEnv });
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "repo" && args[1] === "clone") {
          const r = spawnSync("git", ["clone", "--quiet", remote, args[3]!], { env: gitEnv, encoding: "utf8" });
          return { status: r.status, stdout: r.stdout, stderr: r.stderr };
        }
        if (args[0] === "secret") {
          secret = options.input ?? "";
          return { status: 0, stdout: "", stderr: "" };
        }
      }
      const r = spawnSync(command, args, { cwd: options.cwd, env: gitEnv, encoding: "utf8", input: options.input });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };
    const { publicKey } = initIntegrationRepo("example/adapters", run, () => undefined);
    expect(publicKey).toContain("BEGIN PUBLIC KEY");
    expect(secret).toContain("BEGIN PRIVATE KEY");
    expect(calls).toContain("gh repo create");
    const files = spawnSync("git", ["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"], { env: gitEnv, encoding: "utf8" }).stdout;
    expect(files).toContain(".github/workflows/agent-studio.yml");
    expect(files).toContain("scripts/agent-studio/deliver.mjs");
    expect(files).toContain("AGENTS.md");

    // 2 回目: 既に用意済みなら repository も鍵も作り直さない
    calls.length = 0;
    const again = initIntegrationRepo("example/adapters", run, () => undefined);
    expect(again.publicKey).toBe(publicKey);
    expect(calls).not.toContain("gh repo create");
  });
});
