import "server-only";
import type { AgentDto } from "@agent-studio/contracts";
import { AgentRepository } from "@/lib/repositories";

export class ListAgentsService {
  constructor(private readonly agents = new AgentRepository()) {}

  invoke(): Promise<AgentDto[]> {
    return this.agents.list();
  }
}
