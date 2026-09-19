import "server-only";
import type { WorkflowRunDto } from "@agent-studio/contracts";
import { WorkflowRepository } from "@/lib/repositories";

export class GetWorkflowRunService {
  constructor(private readonly workflows = new WorkflowRepository()) {}

  invoke(runId: string): Promise<WorkflowRunDto> {
    return this.workflows.getRun(runId);
  }
}
