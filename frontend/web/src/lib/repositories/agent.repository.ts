import "server-only";
import type {
  AgentDto,
  AgentVersionDto,
  GenerateManifestResultDto,
  ManifestValidationDto,
} from "@agent-studio/contracts";
import { ApiRepository } from "./base";

/** 生成 AI を呼ぶため長めに待つ */
const GENERATE_TIMEOUT_MS = 120_000;

export class AgentRepository extends ApiRepository {
  list(): Promise<AgentDto[]> {
    return this.api.get<AgentDto[]>("/agents");
  }

  get(id: string): Promise<AgentDto> {
    return this.api.get<AgentDto>(`/agents/${encodeURIComponent(id)}`);
  }

  create(input: { manifest: string }): Promise<AgentDto> {
    return this.api.post<AgentDto>("/agents", input);
  }

  generate(input: { description: string }): Promise<GenerateManifestResultDto> {
    return this.api.post<GenerateManifestResultDto>("/agents/generate", input, { timeoutMs: GENERATE_TIMEOUT_MS });
  }

  validate(input: { manifest: string }): Promise<ManifestValidationDto> {
    return this.api.post<ManifestValidationDto>("/agents/validate", input);
  }

  createVersion(id: string, input: { manifest: string }): Promise<AgentVersionDto> {
    return this.api.post<AgentVersionDto>(`/agents/${encodeURIComponent(id)}/versions`, input);
  }

  publishVersion(id: string, version: number): Promise<AgentVersionDto> {
    return this.api.post<AgentVersionDto>(`/agents/${encodeURIComponent(id)}/versions/${version}/publish`);
  }
}
