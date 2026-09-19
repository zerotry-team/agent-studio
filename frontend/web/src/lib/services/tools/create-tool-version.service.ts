import "server-only";
import { createToolVersionSchema, type CreateToolVersionInput, type ToolVersionDto } from "@agent-studio/contracts";
import { ToolRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

export class CreateToolVersionService {
  constructor(private readonly tools = new ToolRepository()) {}

  invoke(toolId: string, input: CreateToolVersionInput): Promise<ToolVersionDto> {
    return this.tools.createVersion(toolId, parseInput(createToolVersionSchema, input));
  }
}
