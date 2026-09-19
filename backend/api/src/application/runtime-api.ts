import type { Prisma } from "@prisma/client";
import type {
  ApprovalRequest,
  ApprovalResponse,
  ApprovalStatus,
  HeartbeatRequest,
  JobResultRequest,
  Policy,
  RegisterRequest,
  RegisterResponse,
  RuntimeJob,
  SessionEventRequest,
  SessionGrant,
  TokenRequest,
  TokenResponse,
  ToolAuditEvent,
} from "@agent-studio/contracts";
import { AppError, notFound } from "../domain/errors.js";
import { recordAudit } from "../infrastructure/audit.js";
import type { Tx } from "../infrastructure/db/tenant-db.js";
import type { Deps } from "./deps.js";
import { hashToken } from "./environments.js";
import { appendRunEvent } from "./run-events.js";

export interface RuntimeContext {
  runtimeId: string;
  organizationId: string;
  sourceIp: string | null;
}

/** ジョブを取り出してから結果が返るまでの猶予（start_session は Worker の起動を待つため長め） */
const JOB_LEASE_SECONDS = 10 * 60;
const LONG_POLL_INTERVAL_MS = 1000;

const notRegistered = () =>
  new AppError("runtime_not_registered", 403, "この Runtime はまだ登録されていません。登録用トークンで登録してください");
const revoked = () => new AppError("runtime_revoked", 403, "この Runtime は無効にされています");

/**
 * Runtime Controller からの API（Execution Plane → Control Plane）。
 * Runtime の身元は、署名済み GetCallerIdentity で確認した AWS アカウント ID + IAM ロール名で決まる（SEC-05）。
 * 組織は自己申告させない。
 */
export class RuntimeApiService {
  constructor(private readonly deps: Deps) {}

  /** 初回登録（RTM-03）。Bootstrap Token と AWS の身元の両方が一致した場合だけ成功する */
  async register(req: RegisterRequest, sourceIp: string | null): Promise<RegisterResponse> {
    const principal = await this.deps.runtimeIdentity.verify(req.identity);
    const consumed = await this.deps.system.consumeBootstrapToken(hashToken(req.bootstrap_token), principal.accountId, principal.roleName);

    if (!consumed) {
      await this.deps.db.run({ organizationId: null, userId: null }, (tx) =>
        recordAudit(tx, {
          organizationId: null,
          actorType: "runtime",
          actorLabel: principal.arn,
          action: "runtime.register",
          result: "denied",
          sourceIp,
          detail: { aws_account_id: principal.accountId, role: principal.roleName },
        }),
      );
      throw new AppError("bootstrap_invalid", 403, "登録用トークンが無効か、AWS アカウント・ロールが登録内容と一致しません");
    }

    const environmentKey = await this.environmentKeyOf(consumed.organization_id);
    await this.deps.db.org(consumed.organization_id, async (tx) => {
      await tx.runtimes.update({ where: { id: consumed.runtime_id }, data: { controller_version: req.controller_version } });
      await recordAudit(tx, {
        organizationId: consumed.organization_id,
        actorType: "runtime",
        actorId: consumed.runtime_id,
        actorLabel: principal.arn,
        action: "runtime.register",
        targetType: "runtime",
        targetId: consumed.runtime_id,
        sourceIp,
        detail: { aws_account_id: principal.accountId, role: principal.roleName },
      });
    });

    const { token, expiresIn } = await this.deps.runtimeTokens.issue({
      runtimeId: consumed.runtime_id,
      organizationId: consumed.organization_id,
    });
    return {
      runtime_id: consumed.runtime_id,
      organization_id: consumed.organization_id,
      stage: consumed.stage as RegisterResponse["stage"],
      access_token: token,
      expires_in: expiresIn,
      environment_key: environmentKey,
    };
  }

  /** 短期トークンの発行（RTM-04） */
  async token(req: TokenRequest): Promise<TokenResponse> {
    const principal = await this.deps.runtimeIdentity.verify(req.identity);
    const runtime = await this.deps.system.resolveRuntimePrincipal(principal.accountId, principal.roleName);
    if (!runtime || runtime.status === "pending") throw notRegistered();
    if (runtime.status === "revoked") throw revoked();
    const { token, expiresIn } = await this.deps.runtimeTokens.issue({
      runtimeId: runtime.runtime_id,
      organizationId: runtime.organization_id,
    });
    return { runtime_id: runtime.runtime_id, organization_id: runtime.organization_id, access_token: token, expires_in: expiresIn };
  }

  /** アクセストークンを検証し、Runtime が無効にされていないかを毎回確認する */
  async authenticate(accessToken: string, sourceIp: string | null): Promise<RuntimeContext> {
    const claims = await this.deps.runtimeTokens.verify(accessToken);
    const runtime = await this.deps.db.org(claims.organizationId, (tx) =>
      tx.runtimes.findFirst({ where: { id: claims.runtimeId, organization_id: claims.organizationId } }),
    );
    if (!runtime) throw notRegistered();
    if (runtime.status === "revoked") throw revoked();
    return { runtimeId: runtime.id, organizationId: runtime.organization_id, sourceIp };
  }

  async heartbeat(ctx: RuntimeContext, req: HeartbeatRequest): Promise<{ ok: true; server_time: string }> {
    await this.deps.db.org(ctx.organizationId, async (tx) => {
      const runtime = await tx.runtimes.findUniqueOrThrow({ where: { id: ctx.runtimeId } });
      await tx.runtimes.update({
        where: { id: ctx.runtimeId },
        data: {
          controller_version: req.controller_version,
          gateway_url: req.gateway_url,
          tool_catalog: req.tools as unknown as Prisma.InputJsonValue,
          last_heartbeat_at: new Date(),
          ...(runtime.status === "offline" || runtime.status === "degraded" ? { status: "active" } : {}),
        },
      });
      if (runtime.status === "offline") {
        await recordAudit(tx, {
          organizationId: ctx.organizationId,
          actorType: "runtime",
          actorId: ctx.runtimeId,
          action: "runtime.online",
          targetType: "runtime",
          targetId: ctx.runtimeId,
          sourceIp: ctx.sourceIp,
        });
      }
    });
    return { ok: true, server_time: new Date().toISOString() };
  }

  /** long-poll でジョブを1件取り出す（RTM-05）。自分宛てのジョブしか取れない */
  async nextJob(ctx: RuntimeContext, waitSeconds: number, signal: AbortSignal): Promise<RuntimeJob | null> {
    const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), 25) * 1000;
    for (;;) {
      const job = await this.deps.db.org(ctx.organizationId, (tx) => this.leaseJob(tx, ctx.runtimeId));
      if (job || Date.now() >= deadline || signal.aborted) return job;
      await new Promise((r) => setTimeout(r, LONG_POLL_INTERVAL_MS));
    }
  }

  private async leaseJob(tx: Tx, runtimeId: string): Promise<RuntimeJob | null> {
    const rows = await tx.$queryRaw<{ id: string; payload: Record<string, unknown> }[]>`
      UPDATE runtime_jobs
         SET status = 'leased', attempts = attempts + 1, updated_at = now(),
             leased_until = now() + make_interval(secs => ${JOB_LEASE_SECONDS}::integer)
       WHERE id = (
         SELECT id FROM runtime_jobs
          WHERE runtime_id = ${runtimeId}::uuid AND status = 'pending'
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
      RETURNING id, payload`;
    const row = rows[0];
    return row ? ({ ...row.payload, job_id: row.id } as RuntimeJob) : null;
  }

  async jobResult(ctx: RuntimeContext, jobId: string, req: JobResultRequest): Promise<void> {
    await this.deps.db.org(ctx.organizationId, async (tx) => {
      const job = await tx.runtime_jobs.findFirst({ where: { id: jobId, runtime_id: ctx.runtimeId } });
      if (!job) throw notFound("ジョブ");
      if (job.status !== "leased") return;
      await tx.runtime_jobs.update({
        where: { id: jobId },
        data: { status: req.status, error: req.error ?? null, completed_at: new Date(), leased_until: null },
      });
      if (req.status === "failed" && job.type === "start_session" && job.session_id) {
        await this.failSession(tx, job.session_id, `Runtime で作業環境を起動できませんでした: ${req.error ?? "不明なエラー"}`);
      }
    });
  }

  /** Session Worker の状態の報告 */
  async sessionEvent(ctx: RuntimeContext, sessionId: string, req: SessionEventRequest): Promise<void> {
    await this.deps.db.org(ctx.organizationId, async (tx) => {
      const session = await tx.agent_sessions.findFirst({ where: { id: sessionId, runtime_id: ctx.runtimeId } });
      if (!session) throw notFound("セッション");
      const run = { id: session.run_id, organization_id: session.organization_id };
      switch (req.type) {
        case "worker_starting":
          await tx.agent_sessions.update({ where: { id: sessionId }, data: { worker_task_arn: req.task_arn ?? session.worker_task_arn } });
          await appendRunEvent(tx, run, "environment.status", "Runtime が作業環境を起動しています", { worker: req.type });
          break;
        case "worker_running":
          await appendRunEvent(tx, run, "environment.status", "作業環境が起動しました。OpenAI への接続を待っています", { worker: req.type });
          if (session.openai_environment_id) {
            const api = await this.deps.agentsApi.forOrganization(ctx.organizationId);
            api.simulateWorkerConnected?.(session.openai_environment_id);
          }
          break;
        case "worker_stopped":
          if (!session.ended_at) {
            await tx.agent_sessions.update({ where: { id: sessionId }, data: { worker_task_arn: null } });
            await appendRunEvent(tx, run, "environment.status", "作業環境が停止しました", { worker: req.type, detail: req.detail });
          }
          break;
        case "worker_failed":
          await this.failSession(tx, sessionId, `作業環境が異常終了しました: ${req.detail ?? "不明なエラー"}`);
          break;
      }
    });
  }

  private async failSession(tx: Tx, sessionId: string, message: string) {
    const session = await tx.agent_sessions.update({ where: { id: sessionId }, data: { status: "failed" } });
    await appendRunEvent(tx, { id: session.run_id, organization_id: session.organization_id }, "error", message, {});
  }

  /** Tool Gateway がツール呼び出しを認可するための情報（Controller の再起動時に使う） */
  async activeSessions(ctx: RuntimeContext): Promise<SessionGrant[]> {
    return this.deps.db.org(ctx.organizationId, async (tx) => {
      const sessions = await tx.agent_sessions.findMany({
        where: {
          runtime_id: ctx.runtimeId,
          ended_at: null,
          status: { in: ["waiting_worker", "connected"] },
          token_hash: { not: null },
          expires_at: { gt: new Date() },
        },
      });
      return sessions.map((s) => ({
        session_id: s.id,
        run_id: s.run_id,
        token_hash: s.token_hash!,
        allowed_tools: s.allowed_tools as string[],
        policies: s.policies as unknown as Policy[],
        expires_at: s.expires_at!.toISOString(),
      }));
    });
  }

  /** 承認依頼（Tool Gateway から）。同じセッション・同じ引数の依頼があればそれを返す（POL-04） */
  async createApproval(ctx: RuntimeContext, req: ApprovalRequest): Promise<ApprovalResponse> {
    return this.deps.db.org(ctx.organizationId, async (tx) => {
      const session = await tx.agent_sessions.findFirst({ where: { id: req.session_id, runtime_id: ctx.runtimeId, ended_at: null } });
      if (!session) throw notFound("セッション");
      const existing = await tx.approvals.findFirst({
        where: { session_id: session.id, args_hash: req.args_hash, tool: req.tool, status: { in: ["pending", "approved"] } },
        orderBy: { requested_at: "desc" },
      });
      if (existing) return { approval_id: existing.id, status: await this.currentStatus(tx, existing) };

      const approval = await tx.approvals.create({
        data: {
          organization_id: ctx.organizationId,
          run_id: session.run_id,
          session_id: session.id,
          source: "runtime_gateway",
          tool: req.tool,
          args_hash: req.args_hash,
          args_preview: req.args_preview,
          reason: req.reason,
          expires_at: new Date(Date.now() + req.timeout_minutes * 60 * 1000),
        },
      });
      await appendRunEvent(tx, { id: session.run_id, organization_id: session.organization_id }, "approval.requested", `${req.tool} の実行に承認が必要です: ${req.reason}`, {
        approval_id: approval.id,
        tool: req.tool,
        args_preview: req.args_preview,
      });
      await recordAudit(tx, {
        organizationId: ctx.organizationId,
        actorType: "runtime",
        actorId: ctx.runtimeId,
        action: "approval.request",
        targetType: "approval",
        targetId: approval.id,
        sourceIp: ctx.sourceIp,
        detail: { tool: req.tool, run_id: session.run_id },
      });
      return { approval_id: approval.id, status: "pending" };
    });
  }

  async getApproval(ctx: RuntimeContext, approvalId: string): Promise<ApprovalResponse> {
    return this.deps.db.org(ctx.organizationId, async (tx) => {
      const approval = await this.ownApproval(tx, ctx, approvalId);
      return { approval_id: approval.id, status: await this.currentStatus(tx, approval) };
    });
  }

  /** 承認済みの依頼を1回だけ使う。使えた場合だけ status=consumed を返す */
  async consumeApproval(ctx: RuntimeContext, approvalId: string): Promise<ApprovalResponse> {
    return this.deps.db.org(ctx.organizationId, async (tx) => {
      const approval = await this.ownApproval(tx, ctx, approvalId);
      const updated = await tx.approvals.updateMany({
        where: { id: approval.id, status: "approved", expires_at: { gt: new Date() } },
        data: { status: "consumed", consumed_at: new Date() },
      });
      return { approval_id: approval.id, status: updated.count === 1 ? "consumed" : await this.currentStatus(tx, approval) };
    });
  }

  private async ownApproval(tx: Tx, ctx: RuntimeContext, approvalId: string) {
    const approval = await tx.approvals.findFirst({ where: { id: approvalId, source: "runtime_gateway" }, include: { session: true } });
    if (!approval || approval.session?.runtime_id !== ctx.runtimeId) throw notFound("承認依頼");
    return approval;
  }

  private async currentStatus(tx: Tx, approval: { id: string; status: string; expires_at: Date }): Promise<ApprovalStatus> {
    if (approval.status === "pending" && approval.expires_at < new Date()) {
      await tx.approvals.update({ where: { id: approval.id }, data: { status: "expired" } });
      return "expired";
    }
    return approval.status as ApprovalStatus;
  }

  /** Tool Gateway の監査イベント（AUD-05） */
  async audit(ctx: RuntimeContext, events: ToolAuditEvent[]): Promise<void> {
    await this.deps.db.org(ctx.organizationId, async (tx) => {
      const sessionIds = [...new Set(events.map((e) => e.session_id))];
      const owned = new Set(
        (await tx.agent_sessions.findMany({ where: { id: { in: sessionIds }, runtime_id: ctx.runtimeId }, select: { id: true } })).map((s) => s.id),
      );
      await recordAudit(
        tx,
        events
          .filter((e) => owned.has(e.session_id))
          .map((e) => ({
            organizationId: ctx.organizationId,
            actorType: "runtime" as const,
            actorId: ctx.runtimeId,
            action: `tool.${e.decision}`,
            targetType: "session",
            targetId: e.session_id,
            result: e.decision === "denied" ? ("denied" as const) : e.decision === "failed" ? ("failure" as const) : ("success" as const),
            sourceIp: ctx.sourceIp,
            detail: { tool: e.tool, args_hash: e.args_hash, detail: e.detail, duration_ms: e.duration_ms, at: e.at },
          })),
      );
    });
  }

  async environmentKey(ctx: RuntimeContext): Promise<{ environment_key: string | null }> {
    const key = await this.environmentKeyOf(ctx.organizationId);
    await this.deps.db.org(ctx.organizationId, (tx) =>
      recordAudit(tx, {
        organizationId: ctx.organizationId,
        actorType: "runtime",
        actorId: ctx.runtimeId,
        action: "runtime.environment_key.fetch",
        targetType: "runtime",
        targetId: ctx.runtimeId,
        sourceIp: ctx.sourceIp,
      }),
    );
    return { environment_key: key };
  }

  private async environmentKeyOf(organizationId: string): Promise<string | null> {
    const settings = await this.deps.db.org(organizationId, (tx) =>
      tx.organization_openai_settings.findUnique({ where: { organization_id: organizationId } }),
    );
    return settings?.env_key_secret_arn ? this.deps.secrets.get(settings.env_key_secret_arn) : null;
  }
}
