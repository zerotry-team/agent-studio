import "server-only";
import { createManagedRuntimeEnvironmentSchema, type CreateManagedRuntimeEnvironmentInput, type ManagedRuntimeEnvironmentDto } from "@agent-studio/contracts";
import { RuntimeRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

export class CreateManagedRuntimeEnvironmentService {
  constructor(private readonly runtimes = new RuntimeRepository()) {}

  invoke(input: CreateManagedRuntimeEnvironmentInput): Promise<ManagedRuntimeEnvironmentDto> {
    return this.runtimes.createManagedEnvironment(parseInput(createManagedRuntimeEnvironmentSchema, input));
  }
}
