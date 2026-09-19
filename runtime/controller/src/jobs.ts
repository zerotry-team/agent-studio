import type { JobResultRequest, RuntimeJob, SessionEventRequest, StartSessionJob } from "@agent-studio/contracts";
import type { GrantStore } from "./grants.js";
import { isStopped, type SessionLauncher, type WorkerTaskState } from "./launcher.js";
import type { Logger } from "./logger.js";
import { errorInfo } from "./logger.js";
import type { ControllerSecrets } from "./secrets.js";
import type { StudioApi } from "./studio-client.js";

export interface JobHandlerDeps {
  grants: GrantStore;
  launcher: SessionLauncher;
  studio: Pick<StudioApi, "sessionEvent" | "environmentKey">;
  secrets: Pick<ControllerSecrets, "saveEnvironmentKey">;
  logger: Logger;
  limits: { maxConcurrentSessions: number; sessionMaxLifetimeMinutes: number };
  /** RUNNING になるまで待つ上限 */
  startTimeoutMs?: number;
  pollIntervalMs?: number;
  /** 起動直後の DescribeTasks は MISSING を返すことがあるため、この回数までは待つ */
  missingTolerance?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const ok = (): JobResultRequest => ({ status: "succeeded" });
const fail = (error: string): JobResultRequest => ({ status: "failed", error: error.slice(0, 2000) });

export function describeStop(state: WorkerTaskState | null | undefined): string {
  if (!state) return "Session Worker のタスクが見つかりません（起動直後に終了した可能性があります）";
  const reason = state.stoppedReason ?? "理由不明";
  return state.exitCode !== undefined ? `${reason}（終了コード ${state.exitCode}）` : reason;
}

/** Agent Studio から受け取ったジョブを処理する */
export class JobHandler {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  /** 起動待ちの start_session（同じセッションのジョブが再配送されたら、その結果を待つ） */
  private readonly startsInFlight = new Map<string, Promise<JobResultRequest>>();

  constructor(private readonly deps: JobHandlerDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? (() => new Date());
  }

  async handle(job: RuntimeJob): Promise<JobResultRequest> {
    const log = this.deps.logger.child({ job_id: job.job_id, job_type: job.type });
    try {
      switch (job.type) {
        case "start_session": {
          const sessionId = job.session.session_id;
          const inflight = this.startsInFlight.get(sessionId);
          if (inflight) return await inflight;
          const started = this.startSession(job).finally(() => this.startsInFlight.delete(sessionId));
          this.startsInFlight.set(sessionId, started);
          return await started;
        }
        case "stop_session":
          return await this.stopSession(job.session_id, job.reason);
        case "rotate_environment_key":
          return await this.rotateEnvironmentKey();
      }
    } catch (err) {
      log.error({ err: errorInfo(err) }, "ジョブの処理に失敗しました");
      return fail(`ジョブの処理に失敗しました: ${errorInfo(err).message}`);
    }
  }

  private async postEvent(sessionId: string, body: SessionEventRequest): Promise<void> {
    try {
      await this.deps.studio.sessionEvent(sessionId, {
        ...body,
        ...(body.detail ? { detail: body.detail.slice(0, 2000) } : {}),
      });
    } catch (err) {
      this.deps.logger.warn({ err: errorInfo(err), session_id: sessionId, event: body.type }, "セッションのイベントを送れませんでした");
    }
  }

  private async startSession(job: StartSessionJob): Promise<JobResultRequest> {
    const { grants, launcher, logger, limits } = this.deps;
    const {
      openai_session_id: openaiSessionId,
      environment_id: environmentId,
      remote_url: remoteUrl,
      max_lifetime_minutes: requestedLifetime,
      idle_timeout_minutes: idleTimeoutMinutes,
      ...grant
    } = job.session;
    const sessionId = grant.session_id;
    const log = logger.child({ job_id: job.job_id, session_id: sessionId, run_id: grant.run_id });

    const existing = grants.get(sessionId);
    if (existing?.worker) {
      // 同じジョブの再配送（起動済み）。停止処理中のセッションは起動し直さない
      if (existing.worker.status === "running") return ok();
      return fail("このセッションの Session Worker は停止処理中です");
    }
    if (grants.activeWorkerCount() >= limits.maxConcurrentSessions) {
      return fail(
        `同時に実行できるセッション数の上限（${limits.maxConcurrentSessions}）に達しています。実行中のセッションが終わってから、もう一度実行してください`,
      );
    }

    const record = grants.upsert(grant, {
      openaiSessionId,
      environmentId,
      maxLifetimeMinutes: Math.min(requestedLifetime, limits.sessionMaxLifetimeMinutes),
      idleTimeoutMinutes,
      worker: { status: "starting", startedAt: this.now() },
    });
    const worker = record.worker!;

    let taskArn: string;
    try {
      ({ taskArn } = await launcher.launch({
        sessionId,
        runId: grant.run_id,
        remoteUrl,
        environmentId,
        idempotencyToken: job.job_id,
      }));
    } catch (err) {
      grants.remove(sessionId);
      const detail = `Session Worker を起動できませんでした: ${errorInfo(err).message}`;
      log.error({ err: errorInfo(err) }, "Session Worker を起動できませんでした");
      await this.postEvent(sessionId, { type: "worker_failed", detail });
      return fail(detail);
    }
    worker.taskArn = taskArn;
    log.info({ task_arn: taskArn, launcher: launcher.kind }, "Session Worker を起動しました。RUNNING になるのを待ちます");
    await this.postEvent(sessionId, { type: "worker_starting", task_arn: taskArn });

    const deadline = this.now().getTime() + (this.deps.startTimeoutMs ?? 5 * 60_000);
    const pollInterval = this.deps.pollIntervalMs ?? 5_000;
    const missingTolerance = this.deps.missingTolerance ?? 3;
    let missing = 0;

    for (;;) {
      if (grants.get(sessionId) !== record) {
        // 起動待ちの間に stop_session が処理された
        return fail("起動中にセッションが停止されました");
      }

      let state: WorkerTaskState | null | undefined;
      try {
        state = (await launcher.describe([taskArn])).get(taskArn) ?? null;
      } catch (err) {
        log.warn({ err: errorInfo(err) }, "Session Worker の状態を取得できませんでした");
        state = undefined;
      }

      if (state?.lastStatus === "RUNNING") {
        worker.status = "running";
        log.info({ task_arn: taskArn }, "Session Worker が RUNNING になりました");
        await this.postEvent(sessionId, { type: "worker_running", task_arn: taskArn });
        return ok();
      }
      if (state === null) missing++;
      if ((state && isStopped(state)) || (state === null && missing > missingTolerance)) {
        grants.remove(sessionId);
        const detail = `Session Worker が起動できずに終了しました: ${describeStop(state)}`;
        log.error({ task_arn: taskArn, detail }, "Session Worker が起動できずに終了しました");
        await this.postEvent(sessionId, { type: "worker_failed", task_arn: taskArn, detail });
        return fail(detail);
      }
      if (this.now().getTime() >= deadline) {
        const detail = "Session Worker が時間内（5 分）に起動しませんでした";
        await launcher.stop(taskArn, detail).catch((err) => log.warn({ err: errorInfo(err) }, "起動に失敗したタスクを停止できませんでした"));
        grants.remove(sessionId);
        log.error({ task_arn: taskArn }, detail);
        await this.postEvent(sessionId, { type: "worker_failed", task_arn: taskArn, detail });
        return fail(detail);
      }
      await this.sleep(pollInterval);
    }
  }

  /** 冪等: 管理していない・すでに止まっているセッションでも成功を返す */
  async stopSession(sessionId: string, reason: string): Promise<JobResultRequest> {
    const { grants, launcher, logger } = this.deps;
    const log = logger.child({ session_id: sessionId });
    const record = grants.get(sessionId);

    let taskArn = record?.worker?.taskArn;
    if (!taskArn) {
      // Controller の再起動直後などで管理から外れている Worker も止める
      try {
        taskArn = (await launcher.findRunning(sessionId))?.taskArn;
      } catch (err) {
        log.warn({ err: errorInfo(err) }, "停止対象の Session Worker を探せませんでした");
      }
    }

    const stopReason = reason || "Agent Studio からの停止指示";
    if (taskArn) {
      if (record?.worker) {
        record.worker.status = "stopping";
        record.worker.stopReason = stopReason;
      }
      await launcher.stop(taskArn, stopReason);
      log.info({ task_arn: taskArn, reason: stopReason }, "Session Worker を停止しました");
    }

    grants.remove(sessionId);
    if (record || taskArn) {
      await this.postEvent(sessionId, {
        type: "worker_stopped",
        ...(taskArn ? { task_arn: taskArn } : {}),
        detail: stopReason,
      });
    }
    return ok();
  }

  private async rotateEnvironmentKey(): Promise<JobResultRequest> {
    const key = await this.deps.studio.environmentKey();
    if (!key) return fail("Agent Studio から環境キーを取得できませんでした");
    await this.deps.secrets.saveEnvironmentKey(key);
    this.deps.logger.info("環境キーを更新しました（以後に起動する Session Worker から新しいキーを使います）");
    return ok();
  }
}
