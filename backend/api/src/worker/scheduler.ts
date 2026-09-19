import type { Deps } from "../application/deps.js";
import { applyApprovalOutcome } from "../application/runs.js";
import { AuditExporter } from "./audit-export.js";
import { EvalEngine, WorkflowEngine } from "./engines.js";
import { RunDriver } from "./run-driver.js";
import type { StudioFunctionExecutor } from "./studio-functions.js";

const RUN_LEASE_SECONDS = 60;
const RUNTIME_OFFLINE_AFTER_SECONDS = 180;
const JOB_MAX_ATTEMPTS = 3;

/**
 * Worker の定期処理。
 * - Run の取得と実行（RunDriver）
 * - 承認の期限切れ、Runtime のオフライン判定、ジョブの再配送（RTM-06）
 * - 終了した Run のセッションの後片付け（RUN-08）
 * - Workflow と Eval を進める
 */
export class WorkerScheduler {
  private readonly active = new Map<string, Promise<void>>();
  private readonly workflows: WorkflowEngine;
  private readonly evals: EvalEngine;
  private readonly audit: AuditExporter;

  constructor(
    private readonly deps: Deps,
    private readonly functions: StudioFunctionExecutor,
  ) {
    this.workflows = new WorkflowEngine(deps);
    this.evals = new EvalEngine(deps);
    this.audit = new AuditExporter(deps);
  }

  async run(signal: AbortSignal): Promise<void> {
    const loops = [
      this.every(1_000, signal, () => this.claimRuns(signal)),
      this.every(15_000, signal, () => this.maintenance()),
      this.every(10_000, signal, () => this.cleanupSessions()),
      this.every(3_000, signal, () => this.workflows.tick()),
      this.every(10_000, signal, () => this.evals.tick()),
      this.every(10 * 60_000, signal, () => this.audit.tick()),
    ];
    await Promise.all(loops);
    // 停止時: 実行中の Run はリースを手放して終わる（別の Worker が引き継ぐ）
    await Promise.allSettled(this.active.values());
  }

  private async every(intervalMs: number, signal: AbortSignal, task: () => Promise<void>) {
    while (!signal.aborted) {
      try {
        await task();
      } catch (e) {
        this.deps.logger.error({ err: e }, "Worker の定期処理に失敗しました");
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, intervalMs);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      });
    }
  }

  private async claimRuns(signal: AbortSignal) {
    const capacity = this.deps.env.WORKER_MAX_CONCURRENT_RUNS - this.active.size;
    if (capacity <= 0 || signal.aborted) return;
    const claimed = await this.deps.system.claimRuns(this.deps.env.WORKER_ID, RUN_LEASE_SECONDS, capacity);
    for (const { run_id, organization_id } of claimed) {
      if (this.active.has(run_id)) continue;
      const driver = new RunDriver(this.deps, this.functions, run_id, organization_id, signal);
      const p = driver.drive().finally(() => this.active.delete(run_id));
      this.active.set(run_id, p);
    }
  }

  private async maintenance() {
    const expired = await this.deps.system.expireApprovals();
    for (const a of expired) {
      await this.deps.db.org(a.organization_id, async (tx) => {
        const approval = await tx.approvals.findUniqueOrThrow({ where: { id: a.approval_id } });
        await applyApprovalOutcome(tx, approval, "expired");
      });
    }
    const offline = await this.deps.system.markStaleRuntimes(RUNTIME_OFFLINE_AFTER_SECONDS);
    if (offline > 0) this.deps.logger.warn({ count: offline }, "ハートビートが途絶えた Runtime を offline にしました");
    const requeued = await this.deps.system.requeueExpiredJobs(JOB_MAX_ATTEMPTS);
    if (requeued > 0) this.deps.logger.warn({ count: requeued }, "結果が返らなかったジョブを戻しました");
  }

  /** 終了した Run のセッション: OpenAI のセッションを削除し、Runtime に Worker の停止を依頼する */
  private async cleanupSessions() {
    const items = await this.deps.system.listSessionsToCleanup(20);
    for (const item of items) {
      try {
        const session = await this.deps.db.org(item.organization_id, (tx) =>
          tx.agent_sessions.findUniqueOrThrow({ where: { id: item.session_id }, include: { runtime: true } }),
        );
        if (session.openai_session_id) {
          try {
            const api = await this.deps.agentsApi.forOrganization(item.organization_id);
            // 実行中のターンは削除の前に中止する必要がある
            await api.sendEvents(session.openai_session_id, [{ type: "agent.session.input.cancel" }]).catch(() => undefined);
            await api.deleteSession(session.openai_session_id);
          } catch (e) {
            this.deps.logger.warn({ err: e, session_id: session.id }, "OpenAI のセッションを削除できませんでした");
          }
        }
        await this.deps.db.org(item.organization_id, async (tx) => {
          if (session.runtime && session.runtime.status !== "revoked") {
            await tx.runtime_jobs.create({
              data: {
                organization_id: item.organization_id,
                runtime_id: session.runtime.id,
                session_id: session.id,
                type: "stop_session",
                payload: { type: "stop_session", session_id: session.id, reason: "実行が終了しました" },
              },
            });
          }
          await tx.agent_sessions.update({ where: { id: session.id }, data: { ended_at: new Date(), status: "ended" } });
        });
      } catch (e) {
        this.deps.logger.error({ err: e, session_id: item.session_id }, "セッションの後片付けに失敗しました");
      }
    }
  }
}
