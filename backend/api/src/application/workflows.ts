import type { Prisma } from "@prisma/client";
import {
  workflowDefinitionSchema,
  type AuditLogDto,
  type CreateWorkflowInput,
  type UsageDto,
  type WorkflowDefinition,
  type WorkflowDto,
  type WorkflowRunDto,
} from "@agent-studio/contracts";
import { conflict, notFound, validationError } from "../domain/errors.js";
import { recordAudit } from "../infrastructure/audit.js";
import type { Tx } from "../infrastructure/db/tenant-db.js";
import { auditBy, requireRole, scopeOf, type MemberActor } from "./context.js";
import type { Deps } from "./deps.js";
import { toAuditLogDto, toWorkflowDto, toWorkflowRunDto } from "./dto.js";

export type WorkflowStepState = WorkflowRunDto["steps"][number];

export class WorkflowService {
  constructor(private readonly deps: Deps) {}

  async list(actor: MemberActor): Promise<WorkflowDto[]> {
    return this.deps.db.run(scopeOf(actor), async (tx) =>
      (await tx.workflows.findMany({ where: { organization_id: actor.organizationId }, orderBy: { updated_at: "desc" } })).map(toWorkflowDto),
    );
  }

  async get(actor: MemberActor, id: string): Promise<WorkflowDto> {
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const w = await tx.workflows.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!w) throw notFound("ワークフロー");
      return toWorkflowDto(w);
    });
  }

  async create(actor: MemberActor, input: CreateWorkflowInput): Promise<WorkflowDto> {
    requireRole(actor, "builder");
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const dup = await tx.workflows.findUnique({ where: { organization_id_key: { organization_id: actor.organizationId, key: input.key } } });
      if (dup) throw conflict(`キー ${input.key} のワークフローはすでにあります`);
      await this.assertDeployments(tx, actor.organizationId, input.definition);
      const w = await tx.workflows.create({
        data: {
          organization_id: actor.organizationId,
          key: input.key,
          name: input.name,
          definition: input.definition as unknown as Prisma.InputJsonValue,
          created_by: actor.userId,
        },
      });
      await recordAudit(tx, auditBy(actor, { action: "workflow.create", targetType: "workflow", targetId: w.id, detail: { key: w.key } }));
      return toWorkflowDto(w);
    });
  }

  async update(actor: MemberActor, id: string, input: { name: string; definition: WorkflowDefinition }): Promise<WorkflowDto> {
    requireRole(actor, "builder");
    const definition = workflowDefinitionSchema.parse(input.definition);
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const w = await tx.workflows.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!w) throw notFound("ワークフロー");
      await this.assertDeployments(tx, actor.organizationId, definition);
      const updated = await tx.workflows.update({
        where: { id },
        data: { name: input.name, definition: definition as unknown as Prisma.InputJsonValue, version: w.version + 1 },
      });
      await recordAudit(tx, auditBy(actor, { action: "workflow.update", targetType: "workflow", targetId: id, detail: { version: updated.version } }));
      return toWorkflowDto(updated);
    });
  }

  private async assertDeployments(tx: Tx, organizationId: string, definition: WorkflowDefinition) {
    for (const step of definition.steps) {
      if (step.type !== "agent" && step.type !== "tool" && step.type !== "compensate") continue;
      const d = await tx.deployments.findFirst({ where: { id: step.deployment_id, organization_id: organizationId } });
      if (!d) throw validationError(`ステップ ${step.name} のデプロイが見つかりません`);
      if (step.type === "tool") {
        const config = d.compiled_config as {
          function_tools?: Array<{ name?: unknown }>;
          service_mcp_tools?: Array<{ name?: unknown; server_label?: unknown }>;
          runtime_tools?: unknown[];
        };
        const fixedNames = new Set([
          ...(config.function_tools ?? []).flatMap((tool) => typeof tool.name === "string" ? [tool.name] : []),
          ...(config.service_mcp_tools ?? []).flatMap((tool) => [tool.name, tool.server_label].filter((name): name is string => typeof name === "string")),
          ...(config.runtime_tools ?? []).filter((name): name is string => typeof name === "string"),
        ]);
        if (!fixedNames.has(step.tool_name)) {
          throw validationError(`ステップ ${step.name} のTool ${step.tool_name} はデプロイに固定されていません`);
        }
      }
    }
  }

  /** 実行を始める。ステップは Worker が順に進める（WF-03） */
  async start(actor: MemberActor, id: string, input: string): Promise<WorkflowRunDto> {
    requireRole(actor, "operator");
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const w = await tx.workflows.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!w) throw notFound("ワークフロー");
      const definition = w.definition as unknown as WorkflowDefinition;
      const steps: WorkflowStepState[] = definition.steps.map((s) => ({
        key: s.key,
        type: s.type,
        status: "pending",
        run_id: null,
        approval_id: null,
        output: null,
        attempts: 0,
        resume_at: null,
      }));
      const run = await tx.workflow_runs.create({
        data: {
          organization_id: actor.organizationId,
          workflow_id: id,
          workflow_version: w.version,
          definition: w.definition as Prisma.InputJsonValue,
          input,
          current_step: steps[0]?.key ?? null,
          steps: steps as unknown as Prisma.InputJsonValue,
          requested_by: actor.userId,
        },
        include: { workflow: true },
      });
      await recordAudit(tx, auditBy(actor, { action: "workflow.run", targetType: "workflow", targetId: id, detail: { workflow_run_id: run.id } }));
      return toWorkflowRunDto(run);
    });
  }

  async listRuns(actor: MemberActor, workflowId?: string): Promise<WorkflowRunDto[]> {
    return this.deps.db.run(scopeOf(actor), async (tx) =>
      (
        await tx.workflow_runs.findMany({
          where: { organization_id: actor.organizationId, ...(workflowId ? { workflow_id: workflowId } : {}) },
          include: { workflow: true },
          orderBy: { created_at: "desc" },
          take: 100,
        })
      ).map(toWorkflowRunDto),
    );
  }

  async getRun(actor: MemberActor, id: string): Promise<WorkflowRunDto> {
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const r = await tx.workflow_runs.findFirst({ where: { id, organization_id: actor.organizationId }, include: { workflow: true } });
      if (!r) throw notFound("ワークフローの実行");
      return toWorkflowRunDto(r);
    });
  }
}

export class InsightService {
  constructor(private readonly deps: Deps) {}

  async auditLogs(actor: MemberActor, q: { limit: number; before?: string }): Promise<AuditLogDto[]> {
    requireRole(actor, "admin");
    return this.deps.db.run(scopeOf(actor), async (tx) =>
      (
        await tx.audit_logs.findMany({
          where: { organization_id: actor.organizationId, ...(q.before ? { created_at: { lt: new Date(q.before) } } : {}) },
          orderBy: { created_at: "desc" },
          take: q.limit,
        })
      ).map(toAuditLogDto),
    );
  }

  /** 月ごとの利用量（BILL-01） */
  async usage(actor: MemberActor, month: string): Promise<UsageDto> {
    requireRole(actor, "admin");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw validationError("月は YYYY-MM の形式で指定してください");
    const from = new Date(`${month}-01T00:00:00+09:00`);
    const to = new Date(from);
    to.setMonth(to.getMonth() + 1);

    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const rows = await tx.$queryRaw<
        { agent_id: string; agent_name: string; runs: bigint; input_tokens: bigint | null; output_tokens: bigint | null }[]
      >`
        SELECT a.id AS agent_id, a.name AS agent_name, count(r.id) AS runs,
               sum(coalesce((r.usage->>'input_tokens')::bigint, 0)) AS input_tokens,
               sum(coalesce((r.usage->>'output_tokens')::bigint, 0)) AS output_tokens
          FROM runs r
          JOIN deployments d ON d.id = r.deployment_id
          JOIN agents a ON a.id = d.agent_id
         WHERE r.organization_id = ${actor.organizationId}::uuid
           AND r.created_at >= ${from} AND r.created_at < ${to}
         GROUP BY a.id, a.name
         ORDER BY runs DESC`;
      const byAgent = rows.map((r) => ({
        agent_id: r.agent_id,
        agent_name: r.agent_name,
        runs: Number(r.runs),
        input_tokens: Number(r.input_tokens ?? 0),
        output_tokens: Number(r.output_tokens ?? 0),
      }));
      return {
        month,
        runs: byAgent.reduce((s, r) => s + r.runs, 0),
        input_tokens: byAgent.reduce((s, r) => s + r.input_tokens, 0),
        output_tokens: byAgent.reduce((s, r) => s + r.output_tokens, 0),
        by_agent: byAgent,
      };
    });
  }
}
