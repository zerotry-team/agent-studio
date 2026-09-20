"use server";

import type { CreateAgentScheduleInput, UpdateAgentScheduleInput } from "@agent-studio/contracts";
import { runAction } from "@/lib/api/run-action";
import { ScheduleRepository } from "@/lib/repositories/schedule.repository";

export async function listSchedulesAction(agentId: string) {
  return runAction(() => new ScheduleRepository().list(agentId), "Scheduleを取得できませんでした");
}
export async function createScheduleAction(agentId: string, input: CreateAgentScheduleInput) {
  return runAction(() => new ScheduleRepository().create(agentId, input), "Scheduleを作成できませんでした");
}
export async function updateScheduleAction(id: string, input: UpdateAgentScheduleInput) {
  return runAction(() => new ScheduleRepository().update(id, input), "Scheduleを更新できませんでした");
}
export async function deleteScheduleAction(id: string) {
  return runAction(() => new ScheduleRepository().remove(id), "Scheduleを削除できませんでした");
}
