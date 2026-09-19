import type { SessionEventRequest } from "@agent-studio/contracts";
import type { GrantStore, SessionRecord } from "./grants.js";
import { describeStop } from "./jobs.js";
import { isStopped, type SessionLauncher } from "./launcher.js";
import type { Logger } from "./logger.js";
import { errorInfo } from "./logger.js";
import type { StudioApi } from "./studio-client.js";

export interface SessionMonitorDeps {
  grants: GrantStore;
  launcher: SessionLauncher;
  studio: Pick<StudioApi, "sessionEvent">;
  logger: Logger;
  now?: () => Date;
}

/**
 * 実行中の Session Worker を監視する（15 秒ごと）。
 * 終了したら Agent Studio に報告して許可情報を消し、最大寿命を過ぎたら停止する。
 */
export class SessionMonitor {
  private readonly now: () => Date;

  constructor(private readonly deps: SessionMonitorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async tick(): Promise<void> {
    const { grants, launcher, logger } = this.deps;
    // 起動待ちのものは JobHandler が見ている
    const tracked = grants.workerSessions().filter((r) => r.worker?.taskArn && r.worker.status !== "starting");

    if (tracked.length > 0) {
      const states = await launcher.describe(tracked.map((r) => r.worker!.taskArn!));
      const now = this.now();
      for (const record of tracked) {
        const worker = record.worker!;
        const taskArn = worker.taskArn!;
        const state = states.get(taskArn);
        if (grants.get(record.grant.session_id) !== record) continue; // この間に stop_session で外れた

        if (isStopped(state)) {
          grants.remove(record.grant.session_id);
          await this.reportStopped(record, state ?? null);
          continue;
        }

        const deadline = worker.startedAt.getTime() + record.maxLifetimeMinutes * 60_000;
        if (now.getTime() >= deadline && worker.status !== "stopping") {
          const reason = `最大寿命（${record.maxLifetimeMinutes} 分）に達したため停止しました`;
          worker.status = "stopping";
          worker.stopReason = reason;
          try {
            await launcher.stop(taskArn, reason);
            logger.info({ session_id: record.grant.session_id, task_arn: taskArn }, reason);
          } catch (err) {
            // 次の周回でもう一度試す
            worker.status = "running";
            logger.warn({ err: errorInfo(err), session_id: record.grant.session_id }, "最大寿命を過ぎた Session Worker を停止できませんでした");
          }
        }
      }
    }

    grants.sweepExpired(this.now());
  }

  private async reportStopped(record: SessionRecord, state: Parameters<typeof describeStop>[0]): Promise<void> {
    const worker = record.worker!;
    const sessionId = record.grant.session_id;
    // Controller が止めたもの・正常終了は stopped、それ以外（異常終了・タスクの消失）は failed
    const failed = !worker.stopReason && state?.exitCode !== 0;
    const body: SessionEventRequest = failed
      ? { type: "worker_failed", task_arn: worker.taskArn, detail: describeStop(state).slice(0, 2000) }
      : { type: "worker_stopped", task_arn: worker.taskArn, ...(worker.stopReason ? { detail: worker.stopReason } : {}) };
    const log = this.deps.logger.child({ session_id: sessionId, task_arn: worker.taskArn });
    if (failed) log.warn({ detail: body.detail }, "Session Worker が異常終了しました");
    else log.info("Session Worker が終了しました");
    try {
      await this.deps.studio.sessionEvent(sessionId, body);
    } catch (err) {
      log.warn({ err: errorInfo(err) }, "Session Worker の終了を報告できませんでした");
    }
  }
}
