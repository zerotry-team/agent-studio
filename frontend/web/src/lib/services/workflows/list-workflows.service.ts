import "server-only";
import type { WorkflowDto } from "@agent-studio/contracts";
import { WorkflowRepository } from "@/lib/repositories";

export class ListWorkflowsService {
  constructor(private readonly workflows = new WorkflowRepository()) {}

  invoke(): Promise<WorkflowDto[]> {
    return this.workflows.list();
  }
}
