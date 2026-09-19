import "server-only";
import { createToolInputSchema, type CreateToolInput, type ToolDto } from "@agent-studio/contracts";
import { ToolRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

export class CreateToolService {
  constructor(private readonly tools = new ToolRepository()) {}

  invoke(input: CreateToolInput): Promise<ToolDto> {
    return this.tools.create(parseInput(createToolInputSchema, input));
  }
}
