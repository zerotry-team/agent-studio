import { describe, expect, it } from "vitest";
import pino from "pino";
import type { BrowserSessionConfig } from "@agent-studio/contracts";
import { DockerBrowserLauncher } from "./browser-launcher.js";
import type { ExecFileLike } from "./launcher.js";

const logger = pino({ level: "silent" });
const CONTAINER_ID = "c".repeat(64);
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

const config: BrowserSessionConfig = {
  enabled: true,
  mode: "public_ephemeral",
  allowed_domains: ["example.com"],
  code_execution_enabled: false,
  computer_actions_enabled: false,
  viewport: { width: 1440, height: 900 },
};

/** docker run と docker inspect だけを模した exec。呼ばれた引数を記録する。 */
function fakeDocker(hostPort: string | null = "49160"): ExecFileLike & { calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecFileLike = async (_file, args) => {
    calls.push(args);
    if (args[0] === "run") return { stdout: `${CONTAINER_ID}\n`, stderr: "" };
    if (args[0] === "inspect") {
      const ports = hostPort ? { "8931/tcp": [{ HostIp: "127.0.0.1", HostPort: hostPort }] } : {};
      return {
        stdout: JSON.stringify({
          state: { Status: "running", StartedAt: "2026-09-20T00:00:00.000Z" },
          name: `/as-browser-${SESSION_ID}`,
          ports,
        }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  };
  return Object.assign(exec, { calls });
}

describe("DockerBrowserLauncher", () => {
  it("loopback へポートを公開し、そのポートで endpoint を返す", async () => {
    const exec = fakeDocker();
    const launcher = new DockerBrowserLauncher({ type: "docker", image: "agent-studio/browser-worker:local" }, logger, exec);

    const { taskArn, accessToken } = await launcher.launch({ sessionId: SESSION_ID, runId: RUN_ID, config });
    const run = exec.calls.find((args) => args[0] === "run")!;

    expect(run).toContain("-p");
    expect(run[run.indexOf("-p") + 1]).toBe("127.0.0.1:0:8931");
    // 認証情報をコマンドラインに出さない（値は子プロセスの環境変数で渡す）
    expect(run).not.toContain(accessToken);

    const state = (await launcher.describe([taskArn])).get(taskArn)!;
    expect(launcher.endpoint(state, accessToken)).toBe(`http://127.0.0.1:49160/mcp/${accessToken}`);
  });

  it("network 指定のときは同じ network から届くコンテナ名を使う", async () => {
    const exec = fakeDocker();
    const launcher = new DockerBrowserLauncher(
      { type: "docker", image: "agent-studio/browser-worker:local", network: "agent-studio" },
      logger,
      exec,
    );

    const { taskArn, accessToken } = await launcher.launch({ sessionId: SESSION_ID, runId: RUN_ID, config });
    const run = exec.calls.find((args) => args[0] === "run")!;
    expect(run[run.indexOf("--network") + 1]).toBe("agent-studio");

    const state = (await launcher.describe([taskArn])).get(taskArn)!;
    expect(launcher.endpoint(state, accessToken)).toBe(`http://as-browser-${SESSION_ID}:8931/mcp/${accessToken}`);
  });

  it("Controller を再起動しても describe で公開ポートを拾い直す", async () => {
    const exec = fakeDocker();
    const launcher = new DockerBrowserLauncher({ type: "docker", image: "agent-studio/browser-worker:local" }, logger, exec);

    // launch を通っていない（＝再起動後の引き継ぎ）状態
    const state = (await launcher.describe([CONTAINER_ID])).get(CONTAINER_ID)!;
    expect(state.lastStatus).toBe("RUNNING");
    expect(launcher.endpoint(state, "token")).toBe("http://127.0.0.1:49160/mcp/token");
  });

  it("ポートが公開されていなければ endpoint を返さない", async () => {
    const launcher = new DockerBrowserLauncher({ type: "docker", image: "agent-studio/browser-worker:local" }, logger, fakeDocker(null));
    const { taskArn, accessToken } = await launcher.launch({ sessionId: SESSION_ID, runId: RUN_ID, config });
    const state = (await launcher.describe([taskArn])).get(taskArn)!;
    expect(launcher.endpoint(state, accessToken)).toBeNull();
  });
});
