import "server-only";
import { createEvalCaseSchema, type CreateEvalCaseInput, type EvalCaseDto } from "@agent-studio/contracts";
import { EvalRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

export class CreateEvalCaseService {
  constructor(private readonly evals = new EvalRepository()) {}

  invoke(agentId: string, input: CreateEvalCaseInput): Promise<EvalCaseDto> {
    return this.evals.createCase(agentId, parseInput(createEvalCaseSchema, input));
  }
}
