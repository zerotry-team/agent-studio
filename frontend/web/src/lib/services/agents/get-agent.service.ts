import "server-only";
import type { AgentDto } from "@agent-studio/contracts";
import { AgentRepository } from "@/lib/repositories";

/** Agent とバージョンの一覧（新しい順）を取得する */
export class GetAgentService {
  constructor(private readonly agents = new AgentRepository()) {}

  async invoke(id: string): Promise<AgentDto> {
    const agent = await this.agents.get(id);
    return { ...agent, versions: [...(agent.versions ?? [])].sort((a, b) => b.version - a.version) };
  }
}
