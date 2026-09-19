import "server-only";
import type { WorkflowRunDto } from "@agent-studio/contracts";
import { WorkflowRepository } from "@/lib/repositories";

export class ListWorkflowRunsService {
  constructor(private readonly workflows = new WorkflowRepository()) {}

  invoke(query: { workflow_id?: string } = {}): Promise<WorkflowRunDto[]> {
    return this.workflows.listRuns(query);
  }
}
