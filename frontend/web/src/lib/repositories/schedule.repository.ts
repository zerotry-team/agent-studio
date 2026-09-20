import "server-only";
import type { AgentScheduleDto, CreateAgentScheduleInput, UpdateAgentScheduleInput } from "@agent-studio/contracts";
import { ApiRepository } from "./base";

export class ScheduleRepository extends ApiRepository {
  list(agentId: string): Promise<AgentScheduleDto[]> {
    return this.api.get(`/agents/${encodeURIComponent(agentId)}/schedules`);
  }
  create(agentId: string, input: CreateAgentScheduleInput): Promise<AgentScheduleDto> {
    return this.api.post(`/agents/${encodeURIComponent(agentId)}/schedules`, input);
  }
  update(id: string, input: UpdateAgentScheduleInput): Promise<AgentScheduleDto> {
    return this.api.patch(`/schedules/${encodeURIComponent(id)}`, input);
  }
  remove(id: string): Promise<void> {
    return this.api.delete(`/schedules/${encodeURIComponent(id)}`);
  }
}
