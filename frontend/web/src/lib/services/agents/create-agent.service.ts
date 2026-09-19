import "server-only";
import { createAgentSchema, type AgentDto } from "@agent-studio/contracts";
import { AgentRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

/** Manifest（YAML）から Agent を作成する */
export class CreateAgentService {
  constructor(private readonly agents = new AgentRepository()) {}

  invoke(input: { manifest: string }): Promise<AgentDto> {
    return this.agents.create(parseInput(createAgentSchema, input));
  }
}
