import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error JavaScript のモジュール（Session Worker 側）
import { syncOnce } from "../../session-worker/builder-sync.mjs";
import { builderBundleKey, builderInputKey, builderResultKey } from "./builder-transfer.js";
import { EcsBuilderWorkspaces, runCommand, type RunCommand } from "./ecs-builder.js";
import { createLogger } from "./logger.js";
import { MemoryObjectStore } from "./object-store.js";

const REPO_URL = "https://github.com/example/private-adapters.git";
const ids = {
  job: "00000000-0000-4000-8000-000000000001",
  project: "00000000-0000-4000-8000-000000000002",
  changeSet: "00000000-0000-4000-8000-000000000003",
  connection: "00000000-0000-4000-8000-000000000004",
  session: "00000000-0000-4000-8000-000000000005",
};
const TOKEN = "installation-secret-token-1234567890";
const dirs: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();

function setupOrigin(): string {
  const origin = temp("as-origin-");
  const seed = temp("as-seed-");
  git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
  git(seed, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(seed, "README.md"), "# adapters\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "init");
  git(seed, "push", "--quiet", origin, "main");
  return origin;
}

describe("EcsBuilderWorkspaces", () => {
  it("Controller が clone し、Worker の commit を bundle で受け取り、hook を実行せずに builder branch へ push する", async () => {
    const origin = setupOrigin();
    const store = new MemoryObjectStore();
    const seenEnv: NodeJS.ProcessEnv[] = [];
    // GitHub の代わりにローカルの bare repository を使う。token は argv に出ないことも確かめる
    const run: RunCommand = (command, args, options) => {
      expect(args.join(" ")).not.toContain(TOKEN);
      if (options.env) seenEnv.push(options.env);
      return runCommand(command, args.map((arg) => (arg === REPO_URL ? origin : arg)), options);
    };
    const studio = {
      gitCredential: async () => ({ username: "x-access-token" as const, token: TOKEN, expires_at: "2099-01-01T00:00:00.000Z", repository_url: REPO_URL }),
    };
    const builder = new EcsBuilderWorkspaces(store, studio, createLogger("silent"), run, { collectTimeoutMs: 0 });
    const workspace = {
      project_id: ids.project,
      change_set_id: ids.changeSet,
      capability_topic: "inventory",
      repository_url: REPO_URL,
      base_branch: "main",
      branch: "builder/inventory/1",
      adapter_path: "adapters/inventory",
    };
    await builder.prepare(ids.job, workspace);
    expect(seenEnv.every((env) => env.GIT_CONFIG_GLOBAL === "/dev/null")).toBe(true);
    const input = await store.get(builderInputKey(ids.changeSet));
    expect(input).not.toBeNull();

    // ---- Session Worker の代わり: 作業領域を展開して commit し、結果を書く
    const ws = temp("as-ws-");
    writeFileSync(join(ws, "input.tar.gz"), input!);
    execFileSync("tar", ["-xzf", join(ws, "input.tar.gz"), "-C", ws]);
    const repo = join(ws, "repo");
    expect(readFileSync(join(repo, ".git", "config"), "utf8")).not.toContain(TOKEN);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("builder/inventory/1");
    const baseSha = readFileSync(join(ws, ".builder-base-sha"), "utf8").trim();
    mkdirSync(join(repo, "adapters", "inventory"), { recursive: true });
    writeFileSync(join(repo, "adapters", "inventory", "index.mjs"), "export {};\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "inventory adapter");
    const commitSha = git(repo, "rev-parse", "HEAD");
    // Agent が hook を仕込んでも、Controller 側では実行されない
    const pwned = join(ws, "pwned");
    mkdirSync(join(repo, "evil-hooks"));
    writeFileSync(join(repo, "evil-hooks", "pre-push"), `#!/bin/sh\ntouch ${pwned}\n`, { mode: 0o755 });
    git(repo, "config", "core.hooksPath", join(repo, "evil-hooks"));
    const result = {
      change_set_id: ids.changeSet,
      base_sha: baseSha,
      commit_sha: commitSha,
      diff_sha256: "d".repeat(64),
      summary: "在庫の少ない商品を返すAdapter",
      changed_files: ["adapters/inventory/index.mjs"],
      tests: [{ command: "node --test", status: "passed", exit_code: 0 }],
    };
    writeFileSync(join(ws, "outputs", "builder-result.json"), JSON.stringify(result));
    const fetchImpl = async (url: string, init: RequestInit) => {
      const name = url.endsWith("/bundle") ? builderBundleKey(ids.changeSet) : builderResultKey(ids.changeSet);
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer transfer-token");
      await store.put(name, Buffer.from(init.body as Uint8Array));
      return new Response("{}", { status: 200 });
    };
    await syncOnce({ workspace: ws, url: "https://gateway.invalid/builder-workspaces/s/c", token: "transfer-token", last: null, fetchImpl });

    // ---- Controller: 回収と公開
    const collected = await builder.collect({ type: "collect_builder_session_result", job_id: ids.job, session_id: ids.session, change_set_id: ids.changeSet });
    expect(collected.commit_sha).toBe(commitSha);
    const published = await builder.publish({
      type: "publish_builder_branch",
      job_id: ids.job,
      project_id: ids.project,
      change_set_id: ids.changeSet,
      connection_id: ids.connection,
      repository_url: REPO_URL,
      base_branch: "main",
      branch: "builder/inventory/1",
      base_sha: baseSha,
      commit_sha: commitSha,
    });
    expect(published.head_sha).toBe(commitSha);
    expect(git(origin, "rev-parse", "refs/heads/builder/inventory/1")).toBe(commitSha);
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(baseSha);
    expect(existsSync(pwned)).toBe(false);
  });

  it("bundle の commit が結果と違えば回収しない", async () => {
    const store = new MemoryObjectStore();
    const builder = new EcsBuilderWorkspaces(store, { gitCredential: async () => { throw new Error("unused"); } }, createLogger("silent"), runCommand, { collectTimeoutMs: 0 });
    await store.put(builderResultKey(ids.changeSet), Buffer.from(JSON.stringify({
      change_set_id: ids.changeSet, base_sha: "b".repeat(40), commit_sha: "a".repeat(40), diff_sha256: "d".repeat(64),
      summary: "x", changed_files: ["a.mjs"], tests: [{ command: "t", status: "passed", exit_code: 0 }],
    })));
    await store.put(builderBundleKey(ids.changeSet), Buffer.from(`# v2 git bundle\n-${"b".repeat(40)} base\n${"c".repeat(40)} refs/agent-studio/builder-result\n\nPACK`));
    await expect(builder.collect({ type: "collect_builder_session_result", job_id: ids.job, session_id: ids.session, change_set_id: ids.changeSet }))
      .rejects.toThrow("commit_shaと一致しません");
  });
});
