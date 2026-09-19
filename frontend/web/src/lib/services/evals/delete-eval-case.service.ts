import "server-only";
import { EvalRepository } from "@/lib/repositories";

export class DeleteEvalCaseService {
  constructor(private readonly evals = new EvalRepository()) {}

  invoke(caseId: string): Promise<void> {
    return this.evals.deleteCase(caseId);
  }
}
