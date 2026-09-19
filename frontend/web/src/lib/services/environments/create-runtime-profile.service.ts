import "server-only";
import {
  createRuntimeProfileSchema,
  type CreateRuntimeProfileInput,
  type RuntimeProfileDto,
} from "@agent-studio/contracts";
import { RuntimeProfileRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

export class CreateRuntimeProfileService {
  constructor(private readonly profiles = new RuntimeProfileRepository()) {}

  invoke(input: CreateRuntimeProfileInput): Promise<RuntimeProfileDto> {
    return this.profiles.create(parseInput(createRuntimeProfileSchema, input));
  }
}
