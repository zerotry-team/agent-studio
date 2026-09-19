import "server-only";
import { createRunSchema, type CreateRunInput, type RunDto } from "@agent-studio/contracts";
import { RunRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

export class StartRunService {
  constructor(private readonly runs = new RunRepository()) {}

  invoke(input: CreateRunInput): Promise<RunDto> {
    return this.runs.create(parseInput(createRunSchema, input));
  }
}
