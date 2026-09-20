import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  DescribeTasksCommand,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
  type ECSClient,
  type Task,
} from "@aws-sdk/client-ecs";
import type { BrowserSessionConfig } from "@agent-studio/contracts";
import type { BrowserLauncherConfig } from "./config.js";
import { isStopped, type ExecFileLike, type WorkerTaskState } from "./launcher.js";
import type { Logger } from "./logger.js";

export const BROWSER_STARTED_BY_PREFIX = "as-browser/";
const BROWSER_PORT = 8931;

export interface BrowserLaunchRequest {
  sessionId: string;
  runId: string;
  config: BrowserSessionConfig;
  idempotencyToken?: string;
}

export interface BrowserLaunchResult {
  taskArn: string;
  /** Worker が要求する一度の Run にだけ有効なパス token。ログへ出さない。 */
  accessToken: string;
}

export interface BrowserLauncher {
  readonly kind: string;
  launch(req: BrowserLaunchRequest): Promise<BrowserLaunchResult>;
  describe(taskArns: string[]): Promise<Map<string, WorkerTaskState | null>>;
  endpoint(state: WorkerTaskState, accessToken: string): string | null;
  stop(taskArn: string, reason: string): Promise<void>;
  findRunning(sessionId: string): Promise<WorkerTaskState | null>;
  findAllRunning(): Promise<WorkerTaskState[]>;
}

export function browserAccessToken(sessionId: string, runId: string): string {
  return createHash("sha256").update(`agent-studio-browser-v1\n${sessionId}\n${runId}`).digest("base64url");
}

function taskState(task: Task, containerName: string): WorkerTaskState {
  const container = task.containers?.find((item) => item.name === containerName);
  const privateIp = task.attachments
    ?.flatMap((attachment) => attachment.details ?? [])
    .find((detail) => detail.name === "privateIPv4Address")?.value;
  return {
    taskArn: task.taskArn ?? "",
    lastStatus: task.lastStatus ?? "UNKNOWN",
    desiredStatus: task.desiredStatus,
    stoppedReason: task.stoppedReason ?? container?.reason,
    exitCode: container?.exitCode,
    startedAt: task.startedAt ?? task.createdAt,
    privateIp,
    sessionId: task.startedBy?.startsWith(BROWSER_STARTED_BY_PREFIX) ? task.startedBy.slice(BROWSER_STARTED_BY_PREFIX.length) : undefined,
  };
}

export class EcsBrowserLauncher implements BrowserLauncher {
  readonly kind = "ecs";

  constructor(
    private readonly ecs: Pick<ECSClient, "send">,
    private readonly cfg: Extract<BrowserLauncherConfig, { type: "ecs" }>,
  ) {}

  async launch(req: BrowserLaunchRequest): Promise<BrowserLaunchResult> {
    const accessToken = browserAccessToken(req.sessionId, req.runId);
    const out = await this.ecs.send(
      new RunTaskCommand({
        cluster: this.cfg.cluster,
        taskDefinition: this.cfg.taskDefinition,
        launchType: "FARGATE",
        count: 1,
        startedBy: `${BROWSER_STARTED_BY_PREFIX}${req.sessionId}`,
        clientToken: req.idempotencyToken,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: this.cfg.subnets,
            securityGroups: this.cfg.securityGroups,
            assignPublicIp: "DISABLED",
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: this.cfg.containerName,
              environment: [
                { name: "BROWSER_SESSION_TOKEN", value: accessToken },
                { name: "BROWSER_MODE", value: req.config.mode },
                { name: "BROWSER_ALLOWED_DOMAINS", value: req.config.allowed_domains.join(",") },
                { name: "BROWSER_ALLOW_PUBLIC_WEB", value: String(req.config.allow_public_web ?? false) },
                { name: "BROWSER_CODE_EXECUTION_ENABLED", value: String(req.config.code_execution_enabled) },
                { name: "BROWSER_COMPUTER_ACTIONS_ENABLED", value: String(req.config.computer_actions_enabled) },
                { name: "BROWSER_VIEWPORT_WIDTH", value: String(req.config.viewport.width) },
                { name: "BROWSER_VIEWPORT_HEIGHT", value: String(req.config.viewport.height) },
              ],
            },
          ],
        },
        tags: [
          { key: "agentstudio:session_id", value: req.sessionId },
          { key: "agentstudio:run_id", value: req.runId },
          { key: "agentstudio:worker_type", value: "browser" },
        ],
      }),
    );
    const taskArn = out.tasks?.[0]?.taskArn;
    if (!taskArn) {
      const failure = out.failures?.[0];
      throw new Error(`Browser Session Worker を起動できませんでした: ${failure?.reason ?? "理由不明"}`);
    }
    return { taskArn, accessToken };
  }

  async describe(taskArns: string[]): Promise<Map<string, WorkerTaskState | null>> {
    const result = new Map<string, WorkerTaskState | null>();
    for (let i = 0; i < taskArns.length; i += 100) {
      const batch = taskArns.slice(i, i + 100);
      const out = await this.ecs.send(new DescribeTasksCommand({ cluster: this.cfg.cluster, tasks: batch }));
      for (const task of out.tasks ?? []) if (task.taskArn) result.set(task.taskArn, taskState(task, this.cfg.containerName));
      for (const failure of out.failures ?? []) if (failure.arn) result.set(failure.arn, null);
      for (const arn of batch) if (!result.has(arn)) result.set(arn, null);
    }
    return result;
  }

  endpoint(state: WorkerTaskState, accessToken: string): string | null {
    return state.privateIp ? `http://${state.privateIp}:${BROWSER_PORT}/mcp/${accessToken}` : null;
  }

  async stop(taskArn: string, reason: string): Promise<void> {
    try {
      await this.ecs.send(new StopTaskCommand({ cluster: this.cfg.cluster, task: taskArn, reason: reason.slice(0, 255) }));
    } catch (error) {
      if (/not found|cannot be found/i.test((error as Error).message ?? "")) return;
      throw error;
    }
  }

  async findRunning(sessionId: string): Promise<WorkerTaskState | null> {
    const listed = await this.ecs.send(
      new ListTasksCommand({ cluster: this.cfg.cluster, startedBy: `${BROWSER_STARTED_BY_PREFIX}${sessionId}`, desiredStatus: "RUNNING" }),
    );
    const arns = listed.taskArns ?? [];
    if (arns.length === 0) return null;
    const states = await this.describe(arns);
    for (const state of states.values()) if (state && !isStopped(state)) return state;
    return null;
  }

  async findAllRunning(): Promise<WorkerTaskState[]> {
    const listed = await this.ecs.send(new ListTasksCommand({ cluster: this.cfg.cluster, desiredStatus: "RUNNING" }));
    const states = await this.describe(listed.taskArns ?? []);
    return [...states.values()].filter((state): state is WorkerTaskState => Boolean(state?.sessionId && !isStopped(state)));
  }
}

const defaultExec: ExecFileLike = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env: options.env, timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr) }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** docker inspect から取り出す、endpoint の解決に必要な情報 */
interface DockerContainerInfo {
  /** `--network` を使うときの宛先ホスト名 */
  name?: string;
  /** ローカル開発で host 側から届くように公開したポート */
  hostPort?: number;
}

/** docker inspect の Ports から 8931/tcp の host 側ポートを取り出す */
function publishedPort(ports: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null | undefined): number | undefined {
  const bindings = ports?.[`${BROWSER_PORT}/tcp`];
  for (const binding of bindings ?? []) {
    const port = Number(binding.HostPort);
    if (Number.isInteger(port) && port > 0) return port;
  }
  return undefined;
}

export class DockerBrowserLauncher implements BrowserLauncher {
  readonly kind = "docker";
  private readonly containers = new Map<string, DockerContainerInfo>();

  constructor(
    private readonly cfg: Extract<BrowserLauncherConfig, { type: "docker" }>,
    private readonly logger: Logger,
    private readonly exec: ExecFileLike = defaultExec,
  ) {}

  async launch(req: BrowserLaunchRequest): Promise<BrowserLaunchResult> {
    const accessToken = browserAccessToken(req.sessionId, req.runId);
    const name = `as-browser-${req.sessionId}`;
    const args = [
      "run", "--rm", "-d", "--name", name,
      "--label", `agentstudio.browser_session_id=${req.sessionId}`,
      "-e", "BROWSER_SESSION_TOKEN", "-e", "BROWSER_MODE", "-e", "BROWSER_ALLOWED_DOMAINS", "-e", "BROWSER_ALLOW_PUBLIC_WEB",
      "-e", "BROWSER_CODE_EXECUTION_ENABLED", "-e", "BROWSER_COMPUTER_ACTIONS_ENABLED",
      "-e", "BROWSER_VIEWPORT_WIDTH", "-e", "BROWSER_VIEWPORT_HEIGHT",
    ];
    if (this.cfg.network) args.push("--network", this.cfg.network);
    // ローカル開発では Tool Gateway が host 側にいるため、loopback にだけポートを公開する（番号は docker に選ばせる）
    args.push("-p", `127.0.0.1:0:${BROWSER_PORT}`);
    args.push(this.cfg.image);
    const { stdout } = await this.exec("docker", args, {
      env: {
        ...process.env,
        BROWSER_SESSION_TOKEN: accessToken,
        BROWSER_MODE: req.config.mode,
        BROWSER_ALLOWED_DOMAINS: req.config.allowed_domains.join(","),
        BROWSER_ALLOW_PUBLIC_WEB: String(req.config.allow_public_web ?? false),
        BROWSER_CODE_EXECUTION_ENABLED: String(req.config.code_execution_enabled),
        BROWSER_COMPUTER_ACTIONS_ENABLED: String(req.config.computer_actions_enabled),
        BROWSER_VIEWPORT_WIDTH: String(req.config.viewport.width),
        BROWSER_VIEWPORT_HEIGHT: String(req.config.viewport.height),
      },
    });
    const taskArn = stdout.trim().split("\n").pop()?.trim();
    if (!taskArn) throw new Error("docker run が Browser container ID を返しませんでした");
    this.containers.set(taskArn, { name });
    // 公開ポートは起動直後に確定する。取れなくても describe で拾い直せるため、ここでは失敗させない
    await this.describe([taskArn]).catch(() => undefined);
    this.logger.info(
      { session_id: req.sessionId, container_id: taskArn.slice(0, 12), host_port: this.containers.get(taskArn)?.hostPort },
      "Browser Session Worker を起動しました",
    );
    return { taskArn, accessToken };
  }

  /** Controller を再起動しても endpoint を解決できるよう、State と一緒に名前・公開ポートも取り出す */
  private static readonly INSPECT_FORMAT =
    '{"state":{{json .State}},"name":{{json .Name}},"ports":{{json .NetworkSettings.Ports}}}';

  async describe(taskArns: string[]): Promise<Map<string, WorkerTaskState | null>> {
    const result = new Map<string, WorkerTaskState | null>();
    for (const id of taskArns) {
      try {
        const { stdout } = await this.exec("docker", ["inspect", "--format", DockerBrowserLauncher.INSPECT_FORMAT, id], {});
        const inspected = JSON.parse(stdout) as {
          state?: { Status?: string; ExitCode?: number; StartedAt?: string; Error?: string };
          name?: string;
          ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null;
        };
        const state = inspected.state ?? {};
        const running = state.Status === "running";
        this.containers.set(id, {
          name: inspected.name?.replace(/^\//, "") || this.containers.get(id)?.name,
          hostPort: publishedPort(inspected.ports) ?? this.containers.get(id)?.hostPort,
        });
        result.set(id, {
          taskArn: id,
          lastStatus: running ? "RUNNING" : state.Status === "exited" || state.Status === "dead" ? "STOPPED" : "PENDING",
          exitCode: running ? undefined : state.ExitCode,
          stoppedReason: state.Error || undefined,
          startedAt: state.StartedAt ? new Date(state.StartedAt) : undefined,
        });
      } catch {
        result.set(id, null);
      }
    }
    return result;
  }

  /**
   * `--network` があるときは同じ network にいる Tool Gateway からコンテナ名で届く。
   * 無いとき（Tool Gateway が host 側のローカル開発）は loopback に公開したポートを使う。
   */
  endpoint(state: WorkerTaskState, accessToken: string): string | null {
    const container = this.containers.get(state.taskArn);
    if (this.cfg.network) return container?.name ? `http://${container.name}:${BROWSER_PORT}/mcp/${accessToken}` : null;
    return container?.hostPort ? `http://127.0.0.1:${container.hostPort}/mcp/${accessToken}` : null;
  }

  async stop(taskArn: string): Promise<void> {
    try {
      await this.exec("docker", ["stop", "-t", "10", taskArn], {});
    } catch (error) {
      if (!/no such container/i.test(String((error as { stderr?: string }).stderr ?? ""))) throw error;
    } finally {
      this.containers.delete(taskArn);
    }
  }

  async findRunning(sessionId: string): Promise<WorkerTaskState | null> {
    const { stdout } = await this.exec("docker", ["ps", "-q", "--no-trunc", "--filter", `label=agentstudio.browser_session_id=${sessionId}`], {});
    const id = stdout.trim().split("\n")[0]?.trim();
    return id ? ((await this.describe([id])).get(id) ?? null) : null;
  }

  async findAllRunning(): Promise<WorkerTaskState[]> {
    const { stdout } = await this.exec(
      "docker",
      ["ps", "--no-trunc", "--filter", "label=agentstudio.browser_session_id", "--format", "{{.ID}} {{.Label \"agentstudio.browser_session_id\"}}"],
      {},
    );
    const rows = stdout.trim().split("\n").filter(Boolean);
    const states = await this.describe(rows.map((row) => row.split(" ")[0]!));
    return rows.flatMap((row) => {
      const [id, sessionId] = row.split(" ");
      const state = id ? states.get(id) : null;
      return state && sessionId ? [{ ...state, sessionId }] : [];
    });
  }
}

export class NoopBrowserLauncher implements BrowserLauncher {
  readonly kind = "noop";
  private readonly running = new Map<string, WorkerTaskState>();

  async launch(req: BrowserLaunchRequest): Promise<BrowserLaunchResult> {
    const taskArn = `noop-browser:${req.sessionId}`;
    this.running.set(taskArn, { taskArn, lastStatus: "RUNNING", startedAt: new Date(), privateIp: "127.0.0.1", sessionId: req.sessionId });
    return { taskArn, accessToken: browserAccessToken(req.sessionId, req.runId) };
  }

  async describe(taskArns: string[]): Promise<Map<string, WorkerTaskState | null>> {
    return new Map(taskArns.map((arn) => [arn, this.running.get(arn) ?? null]));
  }

  endpoint(_state: WorkerTaskState, accessToken: string): string {
    return `http://127.0.0.1:${BROWSER_PORT}/mcp/${accessToken}`;
  }

  async stop(taskArn: string): Promise<void> {
    this.running.delete(taskArn);
  }

  async findRunning(sessionId: string): Promise<WorkerTaskState | null> {
    return this.running.get(`noop-browser:${sessionId}`) ?? null;
  }
  async findAllRunning(): Promise<WorkerTaskState[]> { return [...this.running.values()]; }
}

export class DisabledBrowserLauncher implements BrowserLauncher {
  readonly kind = "disabled";
  async launch(): Promise<never> { throw new Error("この Runtime では Browser Session が有効ではありません"); }
  async describe(taskArns: string[]): Promise<Map<string, WorkerTaskState | null>> { return new Map(taskArns.map((arn) => [arn, null])); }
  endpoint(): null { return null; }
  async stop(): Promise<void> {}
  async findRunning(): Promise<null> { return null; }
  async findAllRunning(): Promise<WorkerTaskState[]> { return []; }
}
