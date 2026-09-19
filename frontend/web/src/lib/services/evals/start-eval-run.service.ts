import "server-only";
import { startEvalRunSchema, type EvalRunDto } from "@agent-studio/contracts";
import { EvalRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

export class StartEvalRunService {
  constructor(private readonly evals = new EvalRepository()) {}

  invoke(agentId: string, input: { deployment_id: string }): Promise<EvalRunDto> {
    return this.evals.startRun(agentId, parseInput(startEvalRunSchema, input));
  }
}
