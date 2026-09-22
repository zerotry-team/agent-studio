import "server-only";
import type {
  AgentDto,
  AgentProjectDto,
  AgentVersionDto,
  GenerateManifestResultDto,
  LinkAgentConnectionInput,
  SetAgentEnvironmentInput,
  UpdateAgentSettingsInput,
  CreateAgentProjectResultDto,
  ManifestValidationDto,
  SetBrowserAccessInput,
  CreateAgentProjectInput,
} from "@agent-studio/contracts";
import { ApiRepository } from "./base";

/** 生成 AI を呼ぶため長めに待つ */
/** 能力の解決は Agent の複雑さで伸びる。連携サービスが増えるほど長くなるので余裕を持たせる */
const GENERATE_TIMEOUT_MS = 300_000;

export class AgentRepository extends ApiRepository {
  list(): Promise<AgentDto[]> {
    return this.api.get<AgentDto[]>("/agents");
  }

  get(id: string): Promise<AgentDto> {
    return this.api.get<AgentDto>(`/agents/${encodeURIComponent(id)}`);
  }

  createProject(input: CreateAgentProjectInput): Promise<CreateAgentProjectResultDto> {
    return this.api.post<CreateAgentProjectResultDto>("/agent-projects", input, { timeoutMs: GENERATE_TIMEOUT_MS });
  }

  getProject(id: string): Promise<AgentProjectDto> {
    return this.api.get<AgentProjectDto>(`/agents/${encodeURIComponent(id)}/project`);
  }

  linkConnection(id: string, input: LinkAgentConnectionInput): Promise<AgentProjectDto> {
    return this.api.put<AgentProjectDto>(`/agents/${encodeURIComponent(id)}/connections`, input);
  }

  setEnvironment(id: string, input: SetAgentEnvironmentInput): Promise<AgentProjectDto> {
    return this.api.put<AgentProjectDto>(`/agents/${encodeURIComponent(id)}/environment`, input);
  }

  updateSettings(id: string, input: UpdateAgentSettingsInput): Promise<AgentProjectDto> {
    return this.api.put<AgentProjectDto>(`/agents/${encodeURIComponent(id)}/settings`, input);
  }

  createPreview(id: string): Promise<import("@agent-studio/contracts").DeploymentDto> {
    return this.api.post(`/agents/${encodeURIComponent(id)}/preview`);
  }

  setBrowserAccess(id: string, input: SetBrowserAccessInput): Promise<AgentDto> {
    return this.api.put<AgentDto>(`/agents/${id}/browser-access`, input);
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
