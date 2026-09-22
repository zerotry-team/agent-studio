import { execFile } from "node:child_process";
import {
  DescribeTasksCommand,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
  type ECSClient,
  type Task,
} from "@aws-sdk/client-ecs";
import type { LauncherConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { BuilderSessionWorkspace } from "@agent-studio/contracts";

/** ListTasks で自分が起動したタスクを探すための startedBy の接頭辞（ECS では英数字・- _ / だけ使える） */
export const STARTED_BY_PREFIX = "as/";
export const WORKSPACE_DIRECTORY = "/workspace";

export interface LaunchRequest {
  sessionId: string;
  runId: string;
  remoteUrl: string;
  environmentId: string;
  builderWorkspace?: BuilderSessionWorkspace;
  /** 作業領域の成果物の送信先（Tool Gateway）と Session 専用 token。Builder Session では渡さない */
  outputs?: { url: string; token: string };
  /** ECS の Builder Session: 作業領域の受け取り・結果の送信先（Tool Gateway）と Session 専用 token */
  builderTransfer?: { url: string; token: string };
  /** ECS の冪等性トークン（ジョブ ID）。同じジョブの再配送で二重に起動しないため */
  idempotencyToken?: string;
}

/** 起動方法によらない Worker の状態（lastStatus は ECS の値に合わせる） */
export interface WorkerTaskState {
  taskArn: string;
  lastStatus: string;
  desiredStatus?: string;
  stoppedReason?: string;
  /** session-worker コンテナの終了コード */
  exitCode?: number;
  startedAt?: Date;
  /** awsvpc タスクの Private IPv4。Browser Session の動的 endpoint 解決に使う。 */
  privateIp?: string;
  sessionId?: string;
}

export interface SessionLauncher {
  readonly kind: string;
  launch(req: LaunchRequest): Promise<{ taskArn: string }>;
  /** 見つからないタスクは null */
  describe(taskArns: string[]): Promise<Map<string, WorkerTaskState | null>>;
  stop(taskArn: string, reason: string): Promise<void>;
  /** セッションの実行中の Worker（Controller 再起動時の引き継ぎ用） */
  findRunning(sessionId: string): Promise<WorkerTaskState | null>;
  /** Controller再起動やJob消失で取り残されたTaskの検出用。 */
  findAllRunning(): Promise<WorkerTaskState[]>;
}

export function isStopped(state: WorkerTaskState | null | undefined): boolean {
  return !state || state.lastStatus === "STOPPED" || state.lastStatus === "DELETED";
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// ECS（本番）
// ---------------------------------------------------------------------------

export class EcsSessionLauncher implements SessionLauncher {
  readonly kind = "ecs";

  constructor(
    private readonly ecs: Pick<ECSClient, "send">,
    private readonly cfg: Extract<LauncherConfig, { type: "ecs" }>,
  ) {}

  private toState(task: Task): WorkerTaskState {
    const container = task.containers?.find((c) => c.name === this.cfg.containerName);
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
      sessionId: task.startedBy?.startsWith(STARTED_BY_PREFIX) ? task.startedBy.slice(STARTED_BY_PREFIX.length) : undefined,
    };
  }

  async launch(req: LaunchRequest): Promise<{ taskArn: string }> {
    const out = await this.ecs.send(
      new RunTaskCommand({
        cluster: this.cfg.cluster,
        taskDefinition: this.cfg.taskDefinition,
        launchType: "FARGATE",
        count: 1,
        startedBy: `${STARTED_BY_PREFIX}${req.sessionId}`,
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
                { name: "REMOTE_URL", value: req.remoteUrl },
                { name: "ENVIRONMENT_ID", value: req.environmentId },
                { name: "WORKSPACE_DIRECTORY", value: WORKSPACE_DIRECTORY },
                ...(req.outputs ? [
                  { name: "SESSION_OUTPUTS_URL", value: req.outputs.url },
                  { name: "SESSION_OUTPUTS_TOKEN", value: req.outputs.token },
                ] : []),
                ...(req.builderWorkspace ? [
                  { name: "BUILDER_PROJECT_ID", value: req.builderWorkspace.project_id },
                  { name: "BUILDER_CHANGE_SET_ID", value: req.builderWorkspace.change_set_id },
                  { name: "BUILDER_CAPABILITY_TOPIC", value: req.builderWorkspace.capability_topic },
                  { name: "BUILDER_REPOSITORY_URL", value: req.builderWorkspace.repository_url },
                  { name: "BUILDER_BASE_BRANCH", value: req.builderWorkspace.base_branch },
                  { name: "BUILDER_BRANCH", value: req.builderWorkspace.branch },
                  { name: "BUILDER_ADAPTER_PATH", value: req.builderWorkspace.adapter_path },
                ] : []),
                ...(req.builderTransfer ? [
                  { name: "BUILDER_TRANSFER_URL", value: req.builderTransfer.url },
                  { name: "BUILDER_TRANSFER_TOKEN", value: req.builderTransfer.token },
                ] : []),
              ],
            },
          ],
        },
        tags: [
          { key: "agentstudio:session_id", value: req.sessionId },
          { key: "agentstudio:run_id", value: req.runId },
        ],
      }),
    );
    const taskArn = out.tasks?.[0]?.taskArn;
    if (!taskArn) {
      const failure = out.failures?.[0];
      throw new Error(
        `Session Worker を起動できませんでした: ${failure?.reason ?? "理由不明"}${failure?.detail ? `（${failure.detail}）` : ""}`,
      );
    }
    return { taskArn };
  }

  async describe(taskArns: string[]): Promise<Map<string, WorkerTaskState | null>> {
    const result = new Map<string, WorkerTaskState | null>();
    for (const batch of chunk(taskArns, 100)) {
      const out = await this.ecs.send(new DescribeTasksCommand({ cluster: this.cfg.cluster, tasks: batch }));
      for (const task of out.tasks ?? []) if (task.taskArn) result.set(task.taskArn, this.toState(task));
      for (const f of out.failures ?? []) if (f.arn) result.set(f.arn, null);
      for (const arn of batch) if (!result.has(arn)) result.set(arn, null);
    }
    return result;
  }

  async stop(taskArn: string, reason: string): Promise<void> {
    try {
      await this.ecs.send(new StopTaskCommand({ cluster: this.cfg.cluster, task: taskArn, reason: reason.slice(0, 255) }));
    } catch (err) {
      // すでに無いタスクの停止は成功扱い（冪等）
      if (/not found|cannot be found/i.test((err as Error).message ?? "")) return;
      throw err;
    }
  }

  async findRunning(sessionId: string): Promise<WorkerTaskState | null> {
    const listed = await this.ecs.send(
      new ListTasksCommand({
        cluster: this.cfg.cluster,
        startedBy: `${STARTED_BY_PREFIX}${sessionId}`,
        desiredStatus: "RUNNING",
      }),
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

// ---------------------------------------------------------------------------
// Docker（ローカル開発）
// ---------------------------------------------------------------------------

export type ExecFileLike = (
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFileLike = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env: options.env, timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr) }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

const DOCKER_STATUS: Record<string, string> = {
  created: "PENDING",
  restarting: "PENDING",
  running: "RUNNING",
  paused: "RUNNING",
  removing: "STOPPING",
  exited: "STOPPED",
  dead: "STOPPED",
};

/** `docker run --rm -d` で session-worker のイメージを手元で動かす */
export class DockerSessionLauncher implements SessionLauncher {
  readonly kind = "docker";

  constructor(
    private readonly cfg: Extract<LauncherConfig, { type: "docker" }>,
    /** CODEX_API_KEY に渡す環境キー（ECS ではタスク定義の secrets が注入する） */
    private readonly environmentKey: () => Promise<string | null>,
    private readonly logger: Logger,
    private readonly exec: ExecFileLike = defaultExecFile,
  ) {}

  async launch(req: LaunchRequest): Promise<{ taskArn: string }> {
    const key = await this.environmentKey();
    if (!key) throw new Error("環境キーが無いため Session Worker を起動できません");
    const args = [
      "run",
      "--rm",
      "-d",
      "--name",
      `as-session-${req.sessionId}`,
      "--label",
      `agentstudio.session_id=${req.sessionId}`,
      "--label",
      `agentstudio.run_id=${req.runId}`,
      "--add-host",
      "host.docker.internal:host-gateway",
      // 値は子プロセスの環境変数で渡し、コマンドライン（ps）に出さない
      "-e",
      "REMOTE_URL",
      "-e",
      "ENVIRONMENT_ID",
      "-e",
      "WORKSPACE_DIRECTORY",
      "-e",
      "CODEX_API_KEY",
    ];
    if (req.outputs) args.push("-e", "SESSION_OUTPUTS_URL", "-e", "SESSION_OUTPUTS_TOKEN");
    if (req.builderWorkspace) {
      args.push(
        "--mount", `type=volume,source=as-builder-${req.builderWorkspace.change_set_id.replaceAll("-", "")},target=/workspace`,
        "-e", "BUILDER_PROJECT_ID",
        "-e", "BUILDER_CHANGE_SET_ID",
        "-e", "BUILDER_CAPABILITY_TOPIC",
        "-e", "BUILDER_REPOSITORY_URL",
        "-e", "BUILDER_BASE_BRANCH",
        "-e", "BUILDER_BRANCH",
        "-e", "BUILDER_ADAPTER_PATH",
      );
    }
    if (this.cfg.network) args.push("--network", this.cfg.network);
    args.push(this.cfg.image);
    const { stdout } = await this.exec("docker", args, {
      env: {
        ...process.env,
        REMOTE_URL: req.remoteUrl,
        ENVIRONMENT_ID: req.environmentId,
        WORKSPACE_DIRECTORY,
        CODEX_API_KEY: key,
        ...(req.outputs ? { SESSION_OUTPUTS_URL: req.outputs.url, SESSION_OUTPUTS_TOKEN: req.outputs.token } : {}),
        ...(req.builderWorkspace ? {
          BUILDER_PROJECT_ID: req.builderWorkspace.project_id,
          BUILDER_CHANGE_SET_ID: req.builderWorkspace.change_set_id,
          BUILDER_CAPABILITY_TOPIC: req.builderWorkspace.capability_topic,
          BUILDER_REPOSITORY_URL: req.builderWorkspace.repository_url,
          BUILDER_BASE_BRANCH: req.builderWorkspace.base_branch,
          BUILDER_BRANCH: req.builderWorkspace.branch,
          BUILDER_ADAPTER_PATH: req.builderWorkspace.adapter_path,
        } : {}),
      },
    });
    const id = stdout.trim().split("\n").pop()?.trim();
    if (!id) throw new Error("docker run がコンテナ ID を返しませんでした");
    this.logger.info({ session_id: req.sessionId, container_id: id.slice(0, 12) }, "Session Worker（docker）を起動しました");
    return { taskArn: id };
  }

  async describe(taskArns: string[]): Promise<Map<string, WorkerTaskState | null>> {
    const result = new Map<string, WorkerTaskState | null>();
    for (const id of taskArns) {
      try {
        const { stdout } = await this.exec("docker", ["inspect", "--format", "{{json .State}}", id], {});
        const s = JSON.parse(stdout) as { Status?: string; ExitCode?: number; StartedAt?: string; Error?: string };
        const lastStatus = DOCKER_STATUS[s.Status ?? ""] ?? "PENDING";
        result.set(id, {
          taskArn: id,
          lastStatus,
          exitCode: lastStatus === "STOPPED" ? s.ExitCode : undefined,
          stoppedReason: s.Error || undefined,
          startedAt: s.StartedAt ? new Date(s.StartedAt) : undefined,
        });
      } catch {
        // --rm で終了後に消えたコンテナは見つからない
        result.set(id, null);
      }
    }
    return result;
  }

  async stop(taskArn: string, _reason: string): Promise<void> {
    try {
      await this.exec("docker", ["stop", "-t", "10", taskArn], {});
    } catch (err) {
      if (/no such container/i.test(String((err as { stderr?: string }).stderr ?? ""))) return;
      throw err;
    }
  }

  async findRunning(sessionId: string): Promise<WorkerTaskState | null> {
    const { stdout } = await this.exec("docker", ["ps", "-q", "--no-trunc", "--filter", `label=agentstudio.session_id=${sessionId}`], {});
    const id = stdout.trim().split("\n")[0]?.trim();
    if (!id) return null;
    const state = (await this.describe([id])).get(id) ?? null;
    return state && !isStopped(state) ? state : null;
  }

  async findAllRunning(): Promise<WorkerTaskState[]> {
    const { stdout } = await this.exec(
      "docker",
      ["ps", "--no-trunc", "--filter", "label=agentstudio.session_id", "--format", "{{.ID}} {{.Label \"agentstudio.session_id\"}}"],
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

// ---------------------------------------------------------------------------
// noop（Worker を起動しない。Controller・Gateway だけを試すとき）
// ---------------------------------------------------------------------------

export class NoopSessionLauncher implements SessionLauncher {
  readonly kind = "noop";
  private readonly running = new Map<string, WorkerTaskState>();

  constructor(private readonly logger: Logger) {}

  async launch(req: LaunchRequest): Promise<{ taskArn: string }> {
    const taskArn = `noop:${req.sessionId}`;
    this.running.set(taskArn, { taskArn, lastStatus: "RUNNING", startedAt: new Date(), sessionId: req.sessionId });
    this.logger.info({ session_id: req.sessionId, environment_id: req.environmentId }, "（noop）Session Worker を起動したものとして扱います");
    return { taskArn };
  }

  async describe(taskArns: string[]): Promise<Map<string, WorkerTaskState | null>> {
    return new Map(taskArns.map((arn) => [arn, this.running.get(arn) ?? null]));
  }

  async stop(taskArn: string, reason: string): Promise<void> {
    this.running.delete(taskArn);
    this.logger.info({ task_arn: taskArn, reason }, "（noop）Session Worker を停止したものとして扱います");
  }

  async findRunning(sessionId: string): Promise<WorkerTaskState | null> {
    return this.running.get(`noop:${sessionId}`) ?? null;
  }

  async findAllRunning(): Promise<WorkerTaskState[]> {
    return [...this.running.values()];
  }
}
