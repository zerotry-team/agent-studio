import "server-only";
import {
  builderMcpInputSchema,
  builderOpenApiInputSchema,
  createBuilderProjectSchema,
  type ApplyBuilderMcpResultDto,
  type ApplyBuilderOpenApiResultDto,
  type BuilderMcpInput,
  type BuilderMcpProposalDto,
  type BuilderOpenApiInput,
  type BuilderOpenApiProposalDto,
  type BuilderProjectDto,
  type CreateBuilderProjectInput,
  type CompleteBuilderHumanActionInput,
} from "@agent-studio/contracts";
import { BuilderProjectRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

export class ListBuilderProjectsService {
  constructor(private readonly projects = new BuilderProjectRepository()) {}
  invoke(): Promise<BuilderProjectDto[]> { return this.projects.list(); }
}

export class GetBuilderProjectService {
  constructor(private readonly projects = new BuilderProjectRepository()) {}
  invoke(id: string): Promise<BuilderProjectDto> { return this.projects.get(id); }
}

export class CreateBuilderProjectService {
  constructor(private readonly projects = new BuilderProjectRepository()) {}
  invoke(input: CreateBuilderProjectInput): Promise<BuilderProjectDto> {
    return this.projects.create(parseInput(createBuilderProjectSchema, input));
  }
}

export class ResumeBuilderProjectService {
  constructor(private readonly projects = new BuilderProjectRepository()) {}
  invoke(id: string): Promise<BuilderProjectDto> { return this.projects.resume(id); }
}

export class EnsureBuilderProjectAgentService {
  constructor(private readonly projects = new BuilderProjectRepository()) {}
  invoke(id: string): Promise<BuilderProjectDto> { return this.projects.ensureAgent(id); }
}

export class CancelBuilderProjectService {
  constructor(private readonly projects = new BuilderProjectRepository()) {}
  invoke(id: string): Promise<BuilderProjectDto> { return this.projects.cancel(id); }
}

export class CompleteBuilderHumanActionService {
  constructor(private readonly projects = new BuilderProjectRepository()) {}
  invoke(id: string, input: CompleteBuilderHumanActionInput): Promise<BuilderProjectDto> { return this.projects.completeHumanAction(id, input); }
}

export class ApproveBuilderProductionService {
  private readonly projects = new BuilderProjectRepository();
  invoke(id: string): Promise<BuilderProjectDto> { return this.projects.approveProduction(id); }
}

export class InspectBuilderOpenApiService {
  constructor(private readonly projects = new BuilderProjectRepository()) {}
  invoke(id: string, input: BuilderOpenApiInput): Promise<BuilderOpenApiProposalDto> {
    return this.projects.inspectOpenApi(id, parseInput(builderOpenApiInputSchema, input));
  }
}

export class ApplyBuilderOpenApiService {
  constructor(private readonly projects = new BuilderProjectRepository()) {}
  invoke(id: string, input: BuilderOpenApiInput): Promise<ApplyBuilderOpenApiResultDto> {
    return this.projects.applyOpenApi(id, parseInput(builderOpenApiInputSchema, input));
  }
}

export class InspectBuilderMcpService {
  constructor(private readonly projects = new BuilderProjectRepository()) {}
  invoke(id: string, input: BuilderMcpInput): Promise<BuilderMcpProposalDto> {
    return this.projects.inspectMcp(id, parseInput(builderMcpInputSchema, input));
  }
}

export class ApplyBuilderMcpService {
  constructor(private readonly projects = new BuilderProjectRepository()) {}
  invoke(id: string, input: BuilderMcpInput): Promise<ApplyBuilderMcpResultDto> {
    return this.projects.applyMcp(id, parseInput(builderMcpInputSchema, input));
  }
}
