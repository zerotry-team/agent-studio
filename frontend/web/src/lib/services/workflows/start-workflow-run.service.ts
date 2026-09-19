import "server-only";
import { startWorkflowRunSchema, type WorkflowRunDto } from "@agent-studio/contracts";
import { WorkflowRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

export class StartWorkflowRunService {
  constructor(private readonly workflows = new WorkflowRepository()) {}

  invoke(workflowId: string, input: { input: string }): Promise<WorkflowRunDto> {
    return this.workflows.startRun(workflowId, parseInput(startWorkflowRunSchema, input));
  }
}
