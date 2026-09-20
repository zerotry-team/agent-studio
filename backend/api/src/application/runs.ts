import type { Prisma } from "@prisma/client";
import {
  TERMINAL_RUN_STATUSES,
  type ApprovalDecisionInput,
  type ApprovalDto,
  type CreateRunInput,
  type RunArtifactDto,
  type RunDto,
  type RunEventDto,
  type RunStatus,
} from "@agent-studio/contracts";
import { conflict, notFound, preconditionFailed } from "../domain/errors.js";
import { recordAudit } from "../infrastructure/audit.js";
import type { Tx } from "../infrastructure/db/tenant-db.js";
import { artifactPrefix } from "../infrastructure/storage/object-store.js";
import { auditBy, requireApprover, requireRole, scopeOf, type MemberActor } from "./context.js";
import type { Deps } from "./deps.js";
import { runInclude, toApprovalDto, toRunDto, toRunEventDto } from "./dto.js";
import { appendRunEvent, setRunStatus } from "./run-events.js";

/** 承認結果をエージェントに伝える文面（runtime_gateway の承認） */
export const APPROVAL_MESSAGES = {
  approved: (tool: string, id: string) =>
    `承認されました（承認ID: ${id}）。先ほど承認待ちになった ${tool} の操作を、同じ内容でもう一度実行してください。`,
  denied: (tool: string, id: string, comment?: string | null) =>
    `承認者が ${tool} の操作を却下しました（承認ID: ${id}）。${comment ? `コメント: ${comment}。` : ""}この操作は実行せず、その旨を報告してください。`,
  expired: (tool: string, id: string) =>
    `${tool} の操作の承認期限が切れました（承認ID: ${id}）。この操作は実行せず、その旨を報告してください。`,
};

export class RunService {
  constructor(private readonly deps: Deps) {}

  async list(actor: MemberActor, q: { limit: number; before?: string; deployment_id?: string }): Promise<RunDto[]> {
    return this.deps.db.run(scopeOf(actor), async (tx) =>
      (
        await tx.runs.findMany({
          where: {
            organization_id: actor.organizationId,
            ...(q.deployment_id ? { deployment_id: q.deployment_id } : {}),
            ...(q.before ? { created_at: { lt: new Date(q.before) } } : {}),
          },
          include: runInclude,
          orderBy: { created_at: "desc" },
          take: q.limit,
        })
      ).map(toRunDto),
    );
  }

  async get(actor: MemberActor, id: string): Promise<RunDto> {
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const run = await tx.runs.findFirst({ where: { id, organization_id: actor.organizationId }, include: runInclude });
      if (!run) throw notFound("実行");
      return toRunDto(run);
    });
  }

  async events(actor: MemberActor, id: string, afterSeq: number): Promise<{ run: RunDto; events: RunEventDto[] }> {
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const run = await tx.runs.findFirst({ where: { id, organization_id: actor.organizationId }, include: runInclude });
      if (!run) throw notFound("実行");
      const events = await tx.run_events.findMany({
        where: { run_id: id, organization_id: actor.organizationId, seq: { gt: afterSeq } },
        orderBy: { seq: "asc" },
        take: 500,
      });
      return { run: toRunDto(run), events: events.map(toRunEventDto) };
    });
  }

  /** 成果物の一覧（RUN-06）。組織と実行で決まるプレフィックスの中だけを返す */
  async artifacts(actor: MemberActor, id: string): Promise<RunArtifactDto[]> {
    const run = await this.deps.db.run(scopeOf(actor), (tx) => tx.runs.findFirst({ where: { id, organization_id: actor.organizationId } }));
    if (!run) throw notFound("実行");
    const bucket = this.deps.env.ARTIFACTS_BUCKET;
    if (!bucket) return [];
    const prefix = artifactPrefix(actor.organizationId, id);
    const objects = await this.deps.objects.list(bucket, prefix);
    return Promise.all(
      objects.map(async (o) => ({
        path: o.key.slice(prefix.length),
        size_bytes: o.size,
        download_url: await this.deps.objects.presignGet(bucket, o.key, 300),
      })),
    );
  }

  /** 実行を始める（RUN-01）。実際の処理は Worker が行う */
  async create(actor: MemberActor, input: CreateRunInput): Promise<RunDto> {
    requireRole(actor, "operator");
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const run = await createRunInTx(tx, actor.organizationId, input.deployment_id, input.input, actor.userId);
      await recordAudit(tx, auditBy(actor, { action: "run.create", targetType: "run", targetId: run.id, detail: { deployment_id: input.deployment_id } }));
      const full = await tx.runs.findUniqueOrThrow({ where: { id: run.id }, include: runInclude });
      return toRunDto(full);
    });
  }

  /** Project公開API。利用者はDeployment IDを知らず、Agentと環境だけで実行できる。 */
  async createForAgent(actor: MemberActor, agentId: string, stage: "staging" | "production", input: string): Promise<RunDto> {
    requireRole(actor, "operator");
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const deployment = await tx.deployments.findFirst({
        where: {
          organization_id: actor.organizationId,
          agent_id: agentId,
          stage,
          status: "active",
          health_status: "ready",
        },
        orderBy: { created_at: "desc" },
      });
      if (!deployment) throw preconditionFailed(`${stage === "staging" ? "Preview" : "Production"}はReadyではありません`);
      const run = await createRunInTx(tx, actor.organizationId, deployment.id, input, actor.userId);
      await recordAudit(
        tx,
        auditBy(actor, {
          action: "run.create",
          targetType: "run",
          targetId: run.id,
          detail: { agent_id: agentId, stage, deployment_id: deployment.id, source: "agent_api" },
        }),
      );
      return toRunDto(await tx.runs.findUniqueOrThrow({ where: { id: run.id }, include: runInclude }));
    });
  }

  /** 実行中のセッションに追加の指示を送る（Worker がセッションの空きを待って送信する） */
  async sendMessage(actor: MemberActor, id: string, input: string): Promise<void> {
    requireRole(actor, "operator");
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      const run = await tx.runs.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!run) throw notFound("実行");
      if (TERMINAL_RUN_STATUSES.includes(run.status as RunStatus)) throw preconditionFailed("終了した実行には指示を送れません");
      await tx.run_inputs.create({ data: { organization_id: actor.organizationId, run_id: id, kind: "user", input, created_by: actor.userId } });
      await appendRunEvent(tx, run, "message", "追加の指示を受け付けました", { role: "user", text: input });
      if (run.status === "waiting_approval" || run.status === "waiting_input") {
        await setRunStatus(tx, run, "running", {}, "追加の指示");
      }
      await recordAudit(tx, auditBy(actor, { action: "run.message", targetType: "run", targetId: id }));
    });
  }

  /** 中止する（RUN-05）。セッションの後片付けは Worker が行う */
  async cancel(actor: MemberActor, id: string): Promise<RunDto> {
    requireRole(actor, "operator");
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const run = await tx.runs.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!run) throw notFound("実行");
      if (TERMINAL_RUN_STATUSES.includes(run.status as RunStatus)) throw conflict("この実行はすでに終了しています");
      await setRunStatus(tx, run, "cancelled", {}, "利用者が中止しました");
      await tx.approvals.updateMany({
        where: { run_id: id, organization_id: actor.organizationId, status: "pending" },
        data: { status: "expired" },
      });
      await recordAudit(tx, auditBy(actor, { action: "run.cancel", targetType: "run", targetId: id }));
      return toRunDto(await tx.runs.findUniqueOrThrow({ where: { id }, include: runInclude }));
    });
  }

  // ---------------------------------------------------------------------------
  // 承認（POL）
  // ---------------------------------------------------------------------------
  async listApprovals(actor: MemberActor, status?: string): Promise<ApprovalDto[]> {
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const approvals = await tx.approvals.findMany({
        where: { organization_id: actor.organizationId, ...(status ? { status } : {}) },
        include: { run: { include: { deployment: { include: { agent: true } } } } },
        orderBy: { requested_at: "desc" },
        take: 200,
      });
      return approvals.map((a) =>
        toApprovalDto(a, a.run ? { id: a.run.deployment.agent.id, name: a.run.deployment.agent.name } : null),
      );
    });
  }

  async decide(actor: MemberActor, id: string, input: ApprovalDecisionInput): Promise<ApprovalDto> {
    requireApprover(actor);
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const approval = await tx.approvals.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!approval) throw notFound("承認依頼");
      if (approval.status !== "pending") throw conflict("この承認依頼はすでに処理されています");
      if (approval.expires_at < new Date()) {
        await tx.approvals.update({ where: { id }, data: { status: "expired" } });
        throw preconditionFailed("承認の期限が切れています");
      }
      const status = input.decision === "approve" ? "approved" : "denied";
      const updated = await tx.approvals.update({
        where: { id },
        data: { status, decided_by: actor.userId, decided_at: new Date(), comment: input.comment ?? null },
      });
      await applyApprovalOutcome(tx, updated, status);
      await recordAudit(
        tx,
        auditBy(actor, {
          action: `approval.${status}`,
          targetType: "approval",
          targetId: id,
          detail: { tool: approval.tool, run_id: approval.run_id, workflow_run_id: approval.workflow_run_id, comment: input.comment },
        }),
      );
      const run = updated.run_id
        ? await tx.runs.findUnique({ where: { id: updated.run_id }, include: { deployment: { include: { agent: true } } } })
        : null;
      return toApprovalDto(updated, run ? { id: run.deployment.agent.id, name: run.deployment.agent.name } : null);
    });
  }
}

export async function createRunInTx(
  tx: Tx,
  organizationId: string,
  deploymentId: string,
  input: string,
  requestedBy: string | null,
  extra: { workflow_run_id?: string; eval_run_id?: string } = {},
) {
  const deployment = await tx.deployments.findFirst({
    where: { id: deploymentId, organization_id: organizationId },
    include: { runtime_profile: { include: { runtime: true } } },
  });
  if (!deployment) throw notFound("デプロイ");
  if (deployment.status !== "active") throw preconditionFailed("このデプロイは現在使われていません");
  const runtime = deployment.runtime_profile.runtime;
  if (runtime && runtime.status !== "active" && runtime.status !== "degraded") {
    throw preconditionFailed("実行環境の Runtime が接続されていません。Runtime の状態を確認してください");
  }
  const run = await tx.runs.create({
    data: { organization_id: organizationId, deployment_id: deploymentId, input, requested_by: requestedBy, ...extra },
  });
  // 初回の入力も追加の指示と同じ仕組みで Worker が送る
  await tx.run_inputs.create({ data: { organization_id: organizationId, run_id: run.id, kind: "initial", input, created_by: requestedBy } });
  await appendRunEvent(tx, run, "run.status", "実行待ち", { status: "queued" });
  await appendRunEvent(tx, run, "message", "依頼", { role: "user", text: input });
  return run;
}

/**
 * 承認・却下・期限切れの結果を、待っている処理に伝える。
 * - runtime_gateway: エージェントに結果を伝える入力を積み、Run を再開させる
 * - studio_function: Run を requires_action に戻し、Worker が function call の結果を返す
 * - workflow: Workflow の実行を再開させる
 */
export async function applyApprovalOutcome(
  tx: Tx,
  approval: { id: string; organization_id: string; run_id: string | null; workflow_run_id: string | null; source: string; tool: string; comment: string | null },
  status: "approved" | "denied" | "expired",
): Promise<void> {
  if (approval.source === "workflow") {
    if (approval.workflow_run_id) {
      await tx.workflow_runs.updateMany({
        where: { id: approval.workflow_run_id, organization_id: approval.organization_id, status: "waiting_approval" },
        data: { status: "running" },
      });
    }
    return;
  }
  if (!approval.run_id) return;
  const run = await tx.runs.findUnique({ where: { id: approval.run_id } });
  if (!run || TERMINAL_RUN_STATUSES.includes(run.status as RunStatus)) return;

  const label = status === "approved" ? "承認されました" : status === "denied" ? "却下されました" : "期限が切れました";
  await appendRunEvent(tx, run, "approval.decided", `${approval.tool} の承認依頼: ${label}`, {
    approval_id: approval.id,
    status,
    comment: approval.comment,
  });

  if (approval.source === "runtime_gateway") {
    const message =
      status === "approved"
        ? APPROVAL_MESSAGES.approved(approval.tool, approval.id)
        : status === "denied"
          ? APPROVAL_MESSAGES.denied(approval.tool, approval.id, approval.comment)
          : APPROVAL_MESSAGES.expired(approval.tool, approval.id);
    await tx.run_inputs.create({ data: { organization_id: run.organization_id, run_id: run.id, kind: "approval", input: message } });
    if (run.status === "waiting_approval") await setRunStatus(tx, run, "running", {}, "承認の結果を伝えます");
  } else if (approval.source === "studio_function") {
    if (run.status === "waiting_approval") {
      await tx.runs.update({ where: { id: run.id }, data: { status: "requires_action" } as Prisma.runsUpdateInput });
    }
  }
}
