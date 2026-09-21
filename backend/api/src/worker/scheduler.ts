import type { Deps } from "../application/deps.js";
import type { Prisma } from "@prisma/client";
import { applyApprovalOutcome, createRunInTx } from "../application/runs.js";
import { nextScheduleAt } from "../application/schedules.js";
import { AuditExporter } from "./audit-export.js";
import { EvalEngine, WorkflowEngine } from "./engines.js";
import { RunDriver } from "./run-driver.js";
import type { StudioFunctionExecutor } from "./studio-functions.js";
import type { CompiledAgentConfig } from "../domain/manifest-compiler.js";
import { appendRunEvent } from "../application/run-events.js";
import { parseExternalJobResponse } from "./external-jobs.js";
import { BuilderOrchestrator } from "./builder-orchestrator.js";
import { BuilderSessionDriver } from "./builder-session-driver.js";

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
  private readonly activeBuilderSessions = new Map<string, Promise<void>>();
  private readonly workflows: WorkflowEngine;
  private readonly evals: EvalEngine;
  private readonly audit: AuditExporter;
  private readonly builders: BuilderOrchestrator;

  constructor(
    private readonly deps: Deps,
    private readonly functions: StudioFunctionExecutor,
  ) {
    this.workflows = new WorkflowEngine(deps);
    this.evals = new EvalEngine(deps);
    this.audit = new AuditExporter(deps);
    this.builders = new BuilderOrchestrator(deps);
  }

  async run(signal: AbortSignal): Promise<void> {
    const loops = [
      this.every(1_000, signal, () => this.claimRuns(signal)),
      this.every(15_000, signal, () => this.maintenance()),
      this.every(10_000, signal, () => this.cleanupSessions()),
      this.every(3_000, signal, () => this.workflows.tick()),
      this.every(10_000, signal, () => this.evals.tick()),
      this.every(3_000, signal, () => this.pollExternalJobs()),
      this.every(10_000, signal, () => this.runDueSchedules()),
      this.every(2_000, signal, () => this.builders.tick()),
      this.every(1_000, signal, () => this.claimBuilderSessions(signal)),
      this.every(10 * 60_000, signal, () => this.audit.tick()),
    ];
    await Promise.all(loops);
    // 停止時: 実行中の Run はリースを手放して終わる（別の Worker が引き継ぐ）
    await Promise.allSettled(this.active.values());
    await Promise.allSettled(this.activeBuilderSessions.values());
  }

  private async runDueSchedules() {
    const items = await this.deps.system.claimDueSchedules(this.deps.env.WORKER_ID, 60, 20);
    for (const item of items) {
      await this.deps.db.org(item.organization_id, async (tx) => {
        const schedule = await tx.agent_schedules.findUnique({ where: { id: item.schedule_id } });
        if (!schedule || !schedule.enabled) return;
        const days = schedule.days_of_week as number[];
        const nextRunAt = nextScheduleAt(new Date(Date.now() + 1_000), schedule.local_time, days);
        const deployment = await tx.deployments.findFirst({
          where: { organization_id: item.organization_id, agent_id: schedule.agent_id, stage: schedule.stage, status: "active", health_status: "ready" },
          orderBy: { created_at: "desc" },
        });
        if (!deployment) {
          await tx.agent_schedules.update({ where: { id: schedule.id }, data: { next_run_at: nextRunAt, lease_until: null } });
          await tx.audit_logs.createMany({ data: [{ organization_id: item.organization_id, actor_type: "system", action: "schedule.skip", target_type: "agent_schedule", target_id: schedule.id, result: "failure", detail: { reason: "deployment_not_ready", stage: schedule.stage } }] });
          return;
        }
        const run = await createRunInTx(tx, item.organization_id, deployment.id, schedule.input, schedule.created_by);
        await tx.agent_schedules.update({
          where: { id: schedule.id },
          data: { last_run_at: new Date(), last_run_id: run.id, next_run_at: nextRunAt, lease_until: null },
        });
        await tx.audit_logs.createMany({ data: [{ organization_id: item.organization_id, actor_type: "system", actor_id: schedule.id, action: "schedule.run", target_type: "run", target_id: run.id, result: "success", detail: { agent_id: schedule.agent_id, stage: schedule.stage } }] });
      });
    }
  }

  /** publish_postは再実行せず、返されたJob IDをget_jobで確認するだけに限定する。 */
  private async pollExternalJobs() {
    const items = await this.deps.system.listExternalJobs(this.deps.env.WORKER_ID, 20);
    for (const item of items) {
      try {
        const context = await this.deps.db.org(item.organization_id, (tx) =>
          tx.external_jobs.findUniqueOrThrow({
            where: { id: item.job_id },
            include: { run: { include: { deployment: true } } },
          }),
        );
        const config = context.run.deployment.compiled_config as unknown as CompiledAgentConfig;
        const pollTool = config.function_tools.find((tool) => tool.name === context.poll_tool && tool.connector_id === context.connector_id);
        if (!pollTool) throw new Error("Job状態確認の操作がBuildに含まれていません");
        const output = await this.functions.execute(item.organization_id, pollTool, { id: context.provider_job_id }, {
          agentId: context.run.deployment.agent_id,
          stage: context.run.deployment.stage as "staging" | "production",
          runId: context.run_id,
        });
        const parsed = parseExternalJobResponse(output);
        if (!parsed) throw new Error("Job状態の応答を読み取れませんでした");
        const attempts = context.attempts + 1;
        const terminal = parsed.status === "succeeded" || parsed.status === "failed";
        const status = !terminal && attempts >= 20 ? "unknown" : parsed.status;
        await this.deps.db.org(item.organization_id, async (tx) => {
          await tx.external_jobs.update({
            where: { id: context.id },
            data: {
              status,
              response: parsed.response as Prisma.InputJsonValue,
              attempts,
              last_checked_at: new Date(),
              next_poll_at: new Date(Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(attempts, 5))),
              error: null,
            },
          });
          if (status !== context.status || terminal || status === "unknown") {
            await appendRunEvent(tx, context.run, "external.job", status === "succeeded"
              ? `外部サービスの投稿処理が成功しました（Job ${context.provider_job_id}）`
              : status === "failed"
                ? `外部サービスの投稿処理が失敗しました（Job ${context.provider_job_id}）`
                : status === "unknown"
                  ? `外部サービスの投稿結果を確認できませんでした。自動再投稿はしません（Job ${context.provider_job_id}）`
                  : `外部サービスで投稿処理中です（Job ${context.provider_job_id}）`, {
              job_id: context.id,
              provider_job_id: context.provider_job_id,
              status,
              attempts,
            });
          }
          if (status === "failed" || status === "unknown") {
            await tx.runs.updateMany({ where: { id: context.run_id, outcome: { in: ["pending", "succeeded"] } }, data: { outcome: "completed_with_errors" } });
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Job状態の確認に失敗しました";
        await this.deps.db.org(item.organization_id, async (tx) => {
          const job = await tx.external_jobs.findUniqueOrThrow({ where: { id: item.job_id }, include: { run: true } });
          const attempts = job.attempts + 1;
          const unknown = attempts >= 20;
          await tx.external_jobs.update({
            where: { id: job.id },
            data: {
              attempts,
              status: unknown ? "unknown" : job.status,
              error: message.slice(0, 1000),
              last_checked_at: new Date(),
              next_poll_at: new Date(Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(attempts, 5))),
            },
          });
          if (unknown) {
            await tx.runs.updateMany({ where: { id: job.run_id, outcome: { in: ["pending", "succeeded"] } }, data: { outcome: "completed_with_errors" } });
            await appendRunEvent(tx, job.run, "external.job", `外部サービスの投稿結果を確認できませんでした。自動再投稿はしません（Job ${job.provider_job_id}）`, {
              job_id: job.id,
              provider_job_id: job.provider_job_id,
              status: "unknown",
              error: message,
            });
          }
        });
      }
    }
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

  private async claimBuilderSessions(signal: AbortSignal) {
    const capacity = this.deps.env.WORKER_MAX_CONCURRENT_RUNS - this.activeBuilderSessions.size;
    if (capacity <= 0 || signal.aborted) return;
    const claimed = await this.deps.system.claimBuilderWorkspaceSessions(this.deps.env.WORKER_ID, 120, capacity);
    for (const { builder_session_id: sessionId, organization_id: organizationId } of claimed) {
      if (this.activeBuilderSessions.has(sessionId)) continue;
      const driver = new BuilderSessionDriver(this.deps, sessionId, organizationId, signal);
      const task = driver.drive().finally(() => this.activeBuilderSessions.delete(sessionId));
      this.activeBuilderSessions.set(sessionId, task);
    }
  }

  private async maintenance() {
    await this.deps.system.heartbeatWorker(this.deps.env.WORKER_ID, this.active.size, this.activeBuilderSessions.size);
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
    const expiredConnections = await this.deps.system.expireConnections();
    if (expiredConnections > 0) this.deps.logger.info({ count: expiredConnections }, "期限を過ぎたConnectionを利用不可にしました");
  }

  /** 終了した Run のセッション: OpenAI のセッションを削除し、Runtime に Worker の停止を依頼する */
  private async cleanupSessions() {
    const items = await this.deps.system.listSessionsToCleanup(this.deps.env.WORKER_ID, 20);
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
