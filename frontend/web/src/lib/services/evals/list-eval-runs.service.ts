import "server-only";
import type { EvalRunDto } from "@agent-studio/contracts";
import { EvalRepository } from "@/lib/repositories";

export class ListEvalRunsService {
  constructor(private readonly evals = new EvalRepository()) {}

  async invoke(agentId: string): Promise<EvalRunDto[]> {
    const runs = await this.evals.listRuns(agentId);
    return [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
}
