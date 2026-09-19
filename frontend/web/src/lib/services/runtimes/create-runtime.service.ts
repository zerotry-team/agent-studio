import "server-only";
import { createRuntimeSchema, type CreateRuntimeInput, type RuntimeDto } from "@agent-studio/contracts";
import { RuntimeRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

export class CreateRuntimeService {
  constructor(private readonly runtimes = new RuntimeRepository()) {}

  invoke(input: CreateRuntimeInput): Promise<RuntimeDto> {
    return this.runtimes.create(parseInput(createRuntimeSchema, input));
  }
}
