import "server-only";
import { createAgentVersionSchema, type AgentVersionDto } from "@agent-studio/contracts";
import { AgentRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

/** 定義を編集して新しいバージョンを作る（公開済みのバージョンは変更できないため） */
export class CreateAgentVersionService {
  constructor(private readonly agents = new AgentRepository()) {}

  invoke(agentId: string, input: { manifest: string }): Promise<AgentVersionDto> {
    return this.agents.createVersion(agentId, parseInput(createAgentVersionSchema, input));
  }
}
