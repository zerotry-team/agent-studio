import type { agent_schedules, Prisma } from "@prisma/client";
import {
  createAgentScheduleSchema,
  updateAgentScheduleSchema,
  type AgentScheduleDto,
  type CreateAgentScheduleInput,
  type UpdateAgentScheduleInput,
} from "@agent-studio/contracts";
import { notFound, preconditionFailed } from "../domain/errors.js";
import { recordAudit } from "../infrastructure/audit.js";
import { auditBy, requireRole, scopeOf, type MemberActor } from "./context.js";
import type { Deps } from "./deps.js";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function nextScheduleAt(now: Date, localTime: string, daysOfWeek: number[]): Date {
  const [hour, minute] = localTime.split(":").map(Number) as [number, number];
  const localNow = new Date(now.getTime() + JST_OFFSET_MS);
  const allowed = new Set(daysOfWeek);
  for (let offset = 0; offset < 8; offset += 1) {
    const localDay = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate() + offset));
    if (!allowed.has(localDay.getUTCDay())) continue;
    const candidate = new Date(Date.UTC(localDay.getUTCFullYear(), localDay.getUTCMonth(), localDay.getUTCDate(), hour, minute) - JST_OFFSET_MS);
    if (candidate > now) return candidate;
  }
  throw new Error("次回実行日時を計算できませんでした");
}

export function toScheduleDto(row: agent_schedules): AgentScheduleDto {
  return {
    id: row.id,
    agent_id: row.agent_id,
    name: row.name,
    stage: row.stage as AgentScheduleDto["stage"],
    input: row.input,
    timezone: "Asia/Tokyo",
    local_time: row.local_time,
    days_of_week: row.days_of_week as number[],
    enabled: row.enabled,
    next_run_at: row.next_run_at.toISOString(),
    last_run_at: row.last_run_at?.toISOString() ?? null,
    last_run_id: row.last_run_id,
    created_at: row.created_at.toISOString(),
  };
}

export class ScheduleService {
  constructor(private readonly deps: Deps) {}

  async list(actor: MemberActor, agentId: string): Promise<AgentScheduleDto[]> {
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const agent = await tx.agents.findFirst({ where: { id: agentId, organization_id: actor.organizationId } });
      if (!agent) throw notFound("Agent");
      return (await tx.agent_schedules.findMany({ where: { agent_id: agentId }, orderBy: { created_at: "asc" } })).map(toScheduleDto);
    });
  }

  async create(actor: MemberActor, agentId: string, raw: CreateAgentScheduleInput): Promise<AgentScheduleDto> {
    requireRole(actor, "builder");
    const input = createAgentScheduleSchema.parse(raw);
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const agent = await tx.agents.findFirst({ where: { id: agentId, organization_id: actor.organizationId } });
      if (!agent) throw notFound("Agent");
      const deployment = await tx.deployments.findFirst({ where: { agent_id: agentId, stage: input.stage, status: "active", health_status: "ready" } });
      if (!deployment) throw preconditionFailed(`${input.stage === "staging" ? "Preview" : "Production"}がReadyではありません`);
      const row = await tx.agent_schedules.create({
        data: {
          organization_id: actor.organizationId,
          agent_id: agentId,
          name: input.name,
          stage: input.stage,
          input: input.input,
          timezone: input.timezone,
          local_time: input.local_time,
          days_of_week: input.days_of_week as Prisma.InputJsonValue,
          enabled: input.enabled,
          next_run_at: nextScheduleAt(new Date(), input.local_time, input.days_of_week),
          created_by: actor.userId,
        },
      });
      await recordAudit(tx, auditBy(actor, { action: "schedule.create", targetType: "agent_schedule", targetId: row.id, detail: { agent_id: agentId, stage: row.stage } }));
      return toScheduleDto(row);
    });
  }

  async update(actor: MemberActor, id: string, raw: UpdateAgentScheduleInput): Promise<AgentScheduleDto> {
    requireRole(actor, "builder");
    const input = updateAgentScheduleSchema.parse(raw);
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const current = await tx.agent_schedules.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!current) throw notFound("Schedule");
      const localTime = input.local_time ?? current.local_time;
      const days = input.days_of_week ?? current.days_of_week as number[];
      const row = await tx.agent_schedules.update({
        where: { id },
        data: {
          ...input,
          ...(input.days_of_week ? { days_of_week: input.days_of_week as Prisma.InputJsonValue } : {}),
          next_run_at: nextScheduleAt(new Date(), localTime, days),
          lease_until: null,
        },
      });
      await recordAudit(tx, auditBy(actor, { action: "schedule.update", targetType: "agent_schedule", targetId: id }));
      return toScheduleDto(row);
    });
  }

  async delete(actor: MemberActor, id: string): Promise<void> {
    requireRole(actor, "builder");
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      const row = await tx.agent_schedules.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!row) throw notFound("Schedule");
      await tx.agent_schedules.delete({ where: { id } });
      await recordAudit(tx, auditBy(actor, { action: "schedule.delete", targetType: "agent_schedule", targetId: id }));
    });
  }
}
