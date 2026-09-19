import "server-only";
import type { CreateWorkflowInput, WorkflowDefinition, WorkflowDto, WorkflowRunDto } from "@agent-studio/contracts";
import { ApiRepository } from "./base";

export class WorkflowRepository extends ApiRepository {
  list(): Promise<WorkflowDto[]> {
    return this.api.get<WorkflowDto[]>("/workflows");
  }

  get(id: string): Promise<WorkflowDto> {
    return this.api.get<WorkflowDto>(`/workflows/${encodeURIComponent(id)}`);
  }

  create(input: CreateWorkflowInput): Promise<WorkflowDto> {
    return this.api.post<WorkflowDto>("/workflows", input);
  }

  /** 保存するとバージョンが上がる */
  update(id: string, input: { name: string; definition: WorkflowDefinition }): Promise<WorkflowDto> {
    return this.api.put<WorkflowDto>(`/workflows/${encodeURIComponent(id)}`, input);
  }

  startRun(id: string, input: { input: string }): Promise<WorkflowRunDto> {
    return this.api.post<WorkflowRunDto>(`/workflows/${encodeURIComponent(id)}/runs`, input);
  }

  listRuns(query: { workflow_id?: string } = {}): Promise<WorkflowRunDto[]> {
    return this.api.get<WorkflowRunDto[]>("/workflow-runs", query);
  }

  getRun(runId: string): Promise<WorkflowRunDto> {
    return this.api.get<WorkflowRunDto>(`/workflow-runs/${encodeURIComponent(runId)}`);
  }
}
