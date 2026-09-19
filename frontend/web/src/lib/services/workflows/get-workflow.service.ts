import "server-only";
import type { WorkflowDto } from "@agent-studio/contracts";
import { WorkflowRepository } from "@/lib/repositories";

export class GetWorkflowService {
  constructor(private readonly workflows = new WorkflowRepository()) {}

  invoke(id: string): Promise<WorkflowDto> {
    return this.workflows.get(id);
  }
}
