import "server-only";
import type { AgentVersionDto } from "@agent-studio/contracts";
import { AgentRepository } from "@/lib/repositories";
import { InputValidationError } from "@/lib/utils/validation";

export class PublishAgentVersionService {
  constructor(private readonly agents = new AgentRepository()) {}

  invoke(agentId: string, version: number): Promise<AgentVersionDto> {
    if (!Number.isInteger(version) || version < 1) {
      throw new InputValidationError({ version: "バージョンの指定が正しくありません" });
    }
    return this.agents.publishVersion(agentId, version);
  }
}
