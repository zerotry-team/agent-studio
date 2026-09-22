import "server-only";
import { updateAgentSettingsSchema, type AgentProjectDto, type UpdateAgentSettingsInput } from "@agent-studio/contracts";
import { AgentRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

export class UpdateAgentSettingsService {
  constructor(private readonly agents = new AgentRepository()) {}

  invoke(agentId: string, input: UpdateAgentSettingsInput): Promise<AgentProjectDto> {
    return this.agents.updateSettings(agentId, parseInput(updateAgentSettingsSchema, input));
  }
}
