import "server-only";
import type { CreateDeploymentInput, DeploymentDto } from "@agent-studio/contracts";
import { ApiRepository } from "./base";

export class DeploymentRepository extends ApiRepository {
  list(query: { agent_id?: string } = {}): Promise<DeploymentDto[]> {
    return this.api.get<DeploymentDto[]>("/deployments", query);
  }

  create(input: CreateDeploymentInput): Promise<DeploymentDto> {
    return this.api.post<DeploymentDto>("/deployments", input);
  }

  archive(id: string): Promise<DeploymentDto> {
    return this.api.post<DeploymentDto>(`/deployments/${encodeURIComponent(id)}/archive`);
  }
}
