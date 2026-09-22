import "server-only";
import type {
  CreateDeploymentCredentialInput,
  CreateDeploymentInput,
  CreatedDeploymentApiKeyDto,
  CreatedDeploymentWebhookDto,
  DeploymentApiKeyDto,
  DeploymentDto,
  DeploymentWebhookDto,
} from "@agent-studio/contracts";
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

  promote(id: string): Promise<DeploymentDto> {
    return this.api.post<DeploymentDto>(`/deployments/${encodeURIComponent(id)}/promote`);
  }

  rollback(id: string): Promise<DeploymentDto> {
    return this.api.post<DeploymentDto>(`/deployments/${encodeURIComponent(id)}/rollback`);
  }

  listApiKeys(id: string): Promise<DeploymentApiKeyDto[]> {
    return this.api.get<DeploymentApiKeyDto[]>(`/deployments/${encodeURIComponent(id)}/api-keys`);
  }

  createApiKey(id: string, input: CreateDeploymentCredentialInput): Promise<CreatedDeploymentApiKeyDto> {
    return this.api.post<CreatedDeploymentApiKeyDto>(`/deployments/${encodeURIComponent(id)}/api-keys`, input);
  }

  revokeApiKey(id: string): Promise<void> {
    return this.api.delete(`/deployment-api-keys/${encodeURIComponent(id)}`);
  }

  listWebhooks(id: string): Promise<DeploymentWebhookDto[]> {
    return this.api.get<DeploymentWebhookDto[]>(`/deployments/${encodeURIComponent(id)}/webhooks`);
  }

  createWebhook(id: string, input: CreateDeploymentCredentialInput): Promise<CreatedDeploymentWebhookDto> {
    return this.api.post<CreatedDeploymentWebhookDto>(`/deployments/${encodeURIComponent(id)}/webhooks`, input);
  }

  revokeWebhook(id: string): Promise<void> {
    return this.api.delete(`/deployment-webhooks/${encodeURIComponent(id)}`);
  }
}
