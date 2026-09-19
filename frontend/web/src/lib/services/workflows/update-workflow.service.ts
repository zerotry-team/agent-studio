import "server-only";
import { updateWorkflowSchema, type WorkflowDefinition, type WorkflowDto } from "@agent-studio/contracts";
import { WorkflowRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

/** ワークフローを保存する（保存するたびにバージョンが上がる） */
export class UpdateWorkflowService {
  constructor(private readonly workflows = new WorkflowRepository()) {}

  invoke(id: string, input: { name: string; definition: WorkflowDefinition }): Promise<WorkflowDto> {
    return this.workflows.update(id, parseInput(updateWorkflowSchema, input));
  }
}
