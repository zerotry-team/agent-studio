import "server-only";
import type { EvalCaseDto, EvalExpectations, EvalRunDto } from "@agent-studio/contracts";
import { ApiRepository } from "./base";

export class EvalRepository extends ApiRepository {
  listCases(agentId: string): Promise<EvalCaseDto[]> {
    return this.api.get<EvalCaseDto[]>(`/agents/${encodeURIComponent(agentId)}/eval-cases`);
  }

  createCase(agentId: string, input: { name: string; input: string; expectations: EvalExpectations }): Promise<EvalCaseDto> {
    return this.api.post<EvalCaseDto>(`/agents/${encodeURIComponent(agentId)}/eval-cases`, input);
  }

  deleteCase(caseId: string): Promise<void> {
    return this.api.delete(`/eval-cases/${encodeURIComponent(caseId)}`);
  }

  listRuns(agentId: string): Promise<EvalRunDto[]> {
    return this.api.get<EvalRunDto[]>(`/agents/${encodeURIComponent(agentId)}/eval-runs`);
  }

  startRun(agentId: string, input: { deployment_id: string }): Promise<EvalRunDto> {
    return this.api.post<EvalRunDto>(`/agents/${encodeURIComponent(agentId)}/eval-runs`, input);
  }
}
