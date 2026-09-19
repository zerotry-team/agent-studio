import "server-only";
import { generateManifestSchema, type GenerateManifestResultDto } from "@agent-studio/contracts";
import { AgentRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

/** 日本語の業務の説明から Manifest の案を生成する */
export class GenerateManifestService {
  constructor(private readonly agents = new AgentRepository()) {}

  invoke(input: { description: string }): Promise<GenerateManifestResultDto> {
    return this.agents.generate(parseInput(generateManifestSchema, input));
  }
}
