import "server-only";
import { createAgentSchema, type ManifestValidationDto } from "@agent-studio/contracts";
import { AgentRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

/** Manifest をサーバーで検証する（ツールの存在確認なども含む） */
export class ValidateManifestService {
  constructor(private readonly agents = new AgentRepository()) {}

  invoke(input: { manifest: string }): Promise<ManifestValidationDto> {
    return this.agents.validate(parseInput(createAgentSchema, input));
  }
}
