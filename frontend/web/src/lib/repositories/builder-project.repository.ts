import "server-only";
import type {
  ApplyBuilderMcpResultDto,
  ApplyBuilderOpenApiResultDto,
  BuilderMcpInput,
  BuilderMcpProposalDto,
  BuilderOpenApiInput,
  BuilderOpenApiProposalDto,
  BuilderProjectDto,
  CompleteBuilderHumanActionInput,
  CreateBuilderProjectInput,
} from "@agent-studio/contracts";
import { ApiRepository } from "./base";

export class BuilderProjectRepository extends ApiRepository {
  list(): Promise<BuilderProjectDto[]> {
    return this.api.get<BuilderProjectDto[]>("/builder-projects");
  }

  get(id: string): Promise<BuilderProjectDto> {
    return this.api.get<BuilderProjectDto>(`/builder-projects/${encodeURIComponent(id)}`);
  }

  create(input: CreateBuilderProjectInput): Promise<BuilderProjectDto> {
    return this.api.post<BuilderProjectDto>("/builder-projects", input);
  }

  resume(id: string): Promise<BuilderProjectDto> {
    return this.api.post<BuilderProjectDto>(`/builder-projects/${encodeURIComponent(id)}/resume`);
  }

  ensureAgent(id: string): Promise<BuilderProjectDto> {
    return this.api.post<BuilderProjectDto>(`/builder-projects/${encodeURIComponent(id)}/agent`);
  }

  cancel(id: string): Promise<BuilderProjectDto> {
    return this.api.post<BuilderProjectDto>(`/builder-projects/${encodeURIComponent(id)}/cancel`);
  }

  completeHumanAction(id: string, input: CompleteBuilderHumanActionInput): Promise<BuilderProjectDto> {
    return this.api.post<BuilderProjectDto>(`/builder-human-actions/${encodeURIComponent(id)}/complete`, input);
  }

  approveProduction(id: string): Promise<BuilderProjectDto> {
    return this.api.post<BuilderProjectDto>(`/builder-projects/${encodeURIComponent(id)}/production/approve`, {});
  }

  inspectOpenApi(id: string, input: BuilderOpenApiInput): Promise<BuilderOpenApiProposalDto> {
    return this.api.post<BuilderOpenApiProposalDto>(`/builder-projects/${encodeURIComponent(id)}/openapi/inspect`, input);
  }

  applyOpenApi(id: string, input: BuilderOpenApiInput): Promise<ApplyBuilderOpenApiResultDto> {
    return this.api.post<ApplyBuilderOpenApiResultDto>(`/builder-projects/${encodeURIComponent(id)}/openapi/apply`, input);
  }

  inspectMcp(id: string, input: BuilderMcpInput): Promise<BuilderMcpProposalDto> {
    return this.api.post<BuilderMcpProposalDto>(`/builder-projects/${encodeURIComponent(id)}/mcp/inspect`, input);
  }

  applyMcp(id: string, input: BuilderMcpInput): Promise<ApplyBuilderMcpResultDto> {
    return this.api.post<ApplyBuilderMcpResultDto>(`/builder-projects/${encodeURIComponent(id)}/mcp/apply`, input);
  }
}
