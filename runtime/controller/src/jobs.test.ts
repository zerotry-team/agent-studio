import {
  DescribeTasksCommand,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
  type RunTaskCommandInput,
  type Task,
} from "@aws-sdk/client-ecs";
import type { RuntimeJob, SessionEventRequest } from "@agent-studio/contracts";
import { describe, expect, it, vi } from "vitest";
import { GrantStore } from "./grants.js";
import { JobHandler } from "./jobs.js";
import { EcsSessionLauncher } from "./launcher.js";
import { createLogger } from "./logger.js";
import { SessionMonitor } from "./monitor.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "10000000-0000-4000-8000-000000000001";
const JOB_ID = "20000000-0000-4000-8000-000000000001";
const TASK_ARN = "arn:aws:ecs:ap-northeast-1:123456789012:task/as-sample-a-prod/abc";
const logger = createLogger("silent");

const startJob = (overrides: Record<string, unknown> = {}): RuntimeJob => ({
  type: "start_session",
  job_id: JOB_ID,
  session: {
    session_id: SESSION_ID,
    run_id: RUN_ID,
    token_hash: "a".repeat(64),
    allowed_tools: ["get_product"],
    policies: [],
    expires_at: "2099-01-01T00:00:00.000Z",
    openai_session_id: "sess_123",
    environment_id: "env_123",
    remote_url: "wss://example.invalid/remote",
    max_lifetime_minutes: 60,
    idle_timeout_minutes: 10,
    ...overrides,
  },
});

/** ECS クライアントのモック。DescribeTasks は statuses を順に返す */
function fakeEcs(statuses: Array<Partial<Task>>) {
  const calls: { run: RunTaskCommandInput[]; stop: string[]; describe: number; list: number } = {
    run: [],
    stop: [],
    describe: 0,
    list: 0,
  };
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof RunTaskCommand) {
      calls.run.push(cmd.input);
      return { tasks: [{ taskArn: TASK_ARN }], failures: [] };
    }
    if (cmd instanceof DescribeTasksCommand) {
      calls.describe++;
      const next = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
      return { tasks: [{ taskArn: TASK_ARN, ...next }], failures: [] };
    }
    if (cmd instanceof StopTaskCommand) {
      calls.stop.push(cmd.input.task!);
      return {};
    }
    if (cmd instanceof ListTasksCommand) {
      calls.list++;
      return { taskArns: [] };
    }
    throw new Error("unexpected command");
  });
  return { ecs: { send } as never, calls };
}

function setup(statuses: Array<Partial<Task>>, opts: { maxConcurrentSessions?: number } = {}) {
  const { ecs, calls } = fakeEcs(statuses);
  const launcher = new EcsSessionLauncher(ecs, {
    type: "ecs",
    cluster: "as-sample-a-prod",
    taskDefinition: "as-sample-a-prod-session-worker",
    subnets: ["subnet-1", "subnet-2"],
    securityGroups: ["sg-1"],
    containerName: "session-worker",
  });
  const events: Array<{ sessionId: string } & SessionEventRequest> = [];
  const studio = {
    sessionEvent: vi.fn(async (sessionId: string, body: SessionEventRequest) => {
      events.push({ sessionId, ...body });
    }),
    environmentKey: vi.fn(async () => "ek-rotated"),
  };
  const secrets = { saveEnvironmentKey: vi.fn(async () => undefined) };
  const grants = new GrantStore();
  const handler = new JobHandler({
    grants,
    launcher,
    studio,
    secrets,
    logger,
    limits: { maxConcurrentSessions: opts.maxConcurrentSessions ?? 5, sessionMaxLifetimeMinutes: 30 },
    pollIntervalMs: 1,
    sleep: async () => undefined,
  });
  return { handler, grants, calls, events, studio, secrets, launcher };
}

describe("JobHandler start_session", () => {
  it("RunTask で Session Worker を起動し、RUNNING になったら成功を返す", async () => {
    const { handler, grants, calls, events } = setup([{ lastStatus: "PROVISIONING" }, { lastStatus: "PENDING" }, { lastStatus: "RUNNING" }]);
    const result = await handler.handle(startJob());

    expect(result).toEqual({ status: "succeeded" });
    expect(calls.run).toHaveLength(1);
    const input = calls.run[0]!;
    expect(input).toMatchObject({
      cluster: "as-sample-a-prod",
      taskDefinition: "as-sample-a-prod-session-worker",
      launchType: "FARGATE",
      startedBy: `as/${SESSION_ID}`,
      clientToken: JOB_ID,
      networkConfiguration: {
        awsvpcConfiguration: { subnets: ["subnet-1", "subnet-2"], securityGroups: ["sg-1"], assignPublicIp: "DISABLED" },
      },
      tags: [
        { key: "agentstudio:session_id", value: SESSION_ID },
        { key: "agentstudio:run_id", value: RUN_ID },
      ],
    });
    expect(input.overrides?.containerOverrides?.[0]).toEqual({
      name: "session-worker",
      environment: [
        { name: "REMOTE_URL", value: "wss://example.invalid/remote" },
        { name: "ENVIRONMENT_ID", value: "env_123" },
        { name: "WORKSPACE_DIRECTORY", value: "/workspace" },
      ],
    });
    // 環境キーは RunTask に含めない（タスク定義の secrets で注入する）
    expect(JSON.stringify(input)).not.toContain("CODEX_API_KEY");

    expect(events.map((e) => e.type)).toEqual(["worker_starting", "worker_running"]);
    expect(events[0]!.task_arn).toBe(TASK_ARN);

    const record = grants.get(SESSION_ID)!;
    expect(record.worker).toMatchObject({ status: "running", taskArn: TASK_ARN });
    expect(record.maxLifetimeMinutes).toBe(30); // Controller の上限で丸める
    expect(record.openaiSessionId).toBe("sess_123");
    expect(grants.lookupByTokenHash("a".repeat(64))?.allowed_tools).toEqual(["get_product"]);
    // Tool Gateway に渡す SessionGrant には OpenAI の情報を含めない
    expect(grants.lookupByTokenHash("a".repeat(64))).not.toHaveProperty("remote_url");
  });

  it("同時実行数の上限に達していたら起動せずに失敗する", async () => {
    const { handler, grants, calls } = setup([{ lastStatus: "RUNNING" }], { maxConcurrentSessions: 1 });
    grants.upsert(
      {
        session_id: "00000000-0000-4000-8000-000000000009",
        run_id: RUN_ID,
        token_hash: "b".repeat(64),
        allowed_tools: [],
        policies: [],
        expires_at: "2099-01-01T00:00:00.000Z",
      },
      { worker: { status: "running", taskArn: "arn:other", startedAt: new Date() } },
    );
    const result = await handler.handle(startJob());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("上限（1）");
    expect(calls.run).toHaveLength(0);
  });

  it("RUNNING になる前に STOPPED になったら worker_failed を送り、失敗を返す", async () => {
    const { handler, grants, events } = setup([
      { lastStatus: "PENDING" },
      {
        lastStatus: "STOPPED",
        stoppedReason: "CannotPullContainerError: pull access denied",
        containers: [{ name: "session-worker", exitCode: undefined }],
      },
    ]);
    const result = await handler.handle(startJob());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("CannotPullContainerError");
    expect(events.map((e) => e.type)).toEqual(["worker_starting", "worker_failed"]);
    expect(events[1]!.detail).toContain("CannotPullContainerError");
    expect(grants.has(SESSION_ID)).toBe(false);
  });

  it("時間内に起動しなければ停止して失敗を返す", async () => {
    const s = setup([{ lastStatus: "PENDING" }]);
    let t = 0;
    const handler = new JobHandler({
      grants: s.grants,
      launcher: s.launcher,
      studio: s.studio,
      secrets: s.secrets,
      logger,
      limits: { maxConcurrentSessions: 5, sessionMaxLifetimeMinutes: 30 },
      startTimeoutMs: 1_000,
      pollIntervalMs: 400,
      sleep: async (ms) => {
        t += ms;
      },
      now: () => new Date(t),
    });
    const result = await handler.handle(startJob());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("5 分");
    expect(s.calls.stop).toEqual([TASK_ARN]);
    expect(s.events.map((e) => e.type)).toEqual(["worker_starting", "worker_failed"]);
    expect(s.grants.has(SESSION_ID)).toBe(false);
  });

  it("起動待ちの間に同じジョブが再配送されたら、最初の起動の結果を返す", async () => {
    const { handler, calls } = setup([{ lastStatus: "PENDING" }, { lastStatus: "PENDING" }, { lastStatus: "RUNNING" }]);
    const [a, b] = await Promise.all([handler.handle(startJob()), handler.handle(startJob())]);
    expect(a).toEqual({ status: "succeeded" });
    expect(b).toEqual({ status: "succeeded" });
    expect(calls.run).toHaveLength(1);
  });

  it("同じジョブの再配送では二重に起動しない", async () => {
    const { handler, calls } = setup([{ lastStatus: "RUNNING" }]);
    await handler.handle(startJob());
    const again = await handler.handle(startJob());
    expect(again).toEqual({ status: "succeeded" });
    expect(calls.run).toHaveLength(1);
  });
});

describe("JobHandler stop_session / rotate_environment_key", () => {
  it("StopTask して許可情報を消し、worker_stopped を送る。2 回目も成功（冪等）", async () => {
    const { handler, grants, calls, events } = setup([{ lastStatus: "RUNNING" }]);
    await handler.handle(startJob());

    const stop: RuntimeJob = { type: "stop_session", job_id: JOB_ID, session_id: SESSION_ID, reason: "実行が完了しました" };
    expect(await handler.handle(stop)).toEqual({ status: "succeeded" });
    expect(calls.stop).toEqual([TASK_ARN]);
    expect(grants.has(SESSION_ID)).toBe(false);
    expect(grants.lookupByTokenHash("a".repeat(64))).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "worker_stopped", task_arn: TASK_ARN, detail: "実行が完了しました" });

    const eventCount = events.length;
    expect(await handler.handle(stop)).toEqual({ status: "succeeded" });
    expect(calls.stop).toHaveLength(1);
    expect(calls.list).toBe(1); // 管理外の Worker が無いか探す
    expect(events).toHaveLength(eventCount);
  });

  it("環境キーを取り直して Secrets Manager に保存する", async () => {
    const { handler, secrets } = setup([]);
    const result = await handler.handle({ type: "rotate_environment_key", job_id: JOB_ID });
    expect(result).toEqual({ status: "succeeded" });
    expect(secrets.saveEnvironmentKey).toHaveBeenCalledWith("ek-rotated");
  });
});

describe("SessionMonitor", () => {
  it("異常終了した Worker は worker_failed を送り、許可情報を消す", async () => {
    const s = setup([{ lastStatus: "RUNNING" }]);
    await s.handler.handle(startJob());
    const { ecs } = fakeEcs([
      { lastStatus: "STOPPED", stoppedReason: "Essential container in task exited", containers: [{ name: "session-worker", exitCode: 1 }] },
    ]);
    const launcher = new EcsSessionLauncher(ecs, {
      type: "ecs",
      cluster: "c",
      taskDefinition: "td",
      subnets: ["s"],
      securityGroups: ["g"],
      containerName: "session-worker",
    });
    await new SessionMonitor({ grants: s.grants, launcher, studio: s.studio, logger }).tick();
    expect(s.events.at(-1)).toMatchObject({ type: "worker_failed", task_arn: TASK_ARN });
    expect(s.events.at(-1)!.detail).toContain("終了コード 1");
    expect(s.grants.has(SESSION_ID)).toBe(false);
  });

  it("正常終了（終了コード 0）は worker_stopped", async () => {
    const s = setup([{ lastStatus: "RUNNING" }]);
    await s.handler.handle(startJob());
    const { ecs } = fakeEcs([{ lastStatus: "STOPPED", containers: [{ name: "session-worker", exitCode: 0 }] }]);
    const launcher = new EcsSessionLauncher(ecs, {
      type: "ecs",
      cluster: "c",
      taskDefinition: "td",
      subnets: ["s"],
      securityGroups: ["g"],
      containerName: "session-worker",
    });
    await new SessionMonitor({ grants: s.grants, launcher, studio: s.studio, logger }).tick();
    expect(s.events.at(-1)).toMatchObject({ type: "worker_stopped" });
  });

  it("最大寿命を過ぎたら StopTask する", async () => {
    const s = setup([{ lastStatus: "RUNNING" }]);
    await s.handler.handle(startJob());
    const later = new Date(Date.now() + 31 * 60_000);
    await new SessionMonitor({ grants: s.grants, launcher: s.launcher, studio: s.studio, logger, now: () => later }).tick();
    expect(s.calls.stop).toEqual([TASK_ARN]);
    expect(s.grants.get(SESSION_ID)?.worker).toMatchObject({ status: "stopping" });
  });
});
