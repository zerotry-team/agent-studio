import "server-only";
import type { EvalCaseDto } from "@agent-studio/contracts";
import { EvalRepository } from "@/lib/repositories";

export class ListEvalCasesService {
  constructor(private readonly evals = new EvalRepository()) {}

  invoke(agentId: string): Promise<EvalCaseDto[]> {
    return this.evals.listCases(agentId);
  }
}
