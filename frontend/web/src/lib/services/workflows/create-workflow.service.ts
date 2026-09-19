import "server-only";
import { createWorkflowSchema, type CreateWorkflowInput, type WorkflowDto } from "@agent-studio/contracts";
import { WorkflowRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

export class CreateWorkflowService {
  constructor(private readonly workflows = new WorkflowRepository()) {}

  invoke(input: CreateWorkflowInput): Promise<WorkflowDto> {
    return this.workflows.create(parseInput(createWorkflowSchema, input));
  }
}
