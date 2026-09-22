import "server-only";
import {
  createDeploymentCredentialSchema,
  type CreateDeploymentCredentialInput,
  type CreatedDeploymentApiKeyDto,
  type CreatedDeploymentWebhookDto,
  type DeploymentApiKeyDto,
  type DeploymentWebhookDto,
} from "@agent-studio/contracts";
import { DeploymentRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

export class DeploymentCredentialsService {
  constructor(private readonly deployments = new DeploymentRepository()) {}

  listApiKeys(deploymentId: string): Promise<DeploymentApiKeyDto[]> {
    return this.deployments.listApiKeys(deploymentId);
  }

  createApiKey(deploymentId: string, input: CreateDeploymentCredentialInput): Promise<CreatedDeploymentApiKeyDto> {
    return this.deployments.createApiKey(deploymentId, parseInput(createDeploymentCredentialSchema, input));
  }

  revokeApiKey(id: string): Promise<void> {
    return this.deployments.revokeApiKey(id);
  }

  listWebhooks(deploymentId: string): Promise<DeploymentWebhookDto[]> {
    return this.deployments.listWebhooks(deploymentId);
  }

  createWebhook(deploymentId: string, input: CreateDeploymentCredentialInput): Promise<CreatedDeploymentWebhookDto> {
    return this.deployments.createWebhook(deploymentId, parseInput(createDeploymentCredentialSchema, input));
  }

  revokeWebhook(id: string): Promise<void> {
    return this.deployments.revokeWebhook(id);
  }
}
