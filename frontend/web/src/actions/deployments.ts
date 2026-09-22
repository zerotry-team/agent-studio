"use server";

import type { CreateDeploymentCredentialInput, CreateDeploymentInput } from "@agent-studio/contracts";
import { runAction } from "@/lib/api/run-action";
import {
  ArchiveDeploymentService,
  CreateDeploymentService,
  ListDeploymentsService,
  PromoteDeploymentService,
  RollbackDeploymentService,
  DeploymentCredentialsService,
} from "@/lib/services/deployments";

export async function listDeploymentsAction(query: { agent_id?: string } = {}) {
  return runAction(() => new ListDeploymentsService().invoke(query), "デプロイの一覧を取得できませんでした");
}

export async function createDeploymentAction(input: CreateDeploymentInput) {
  return runAction(() => new CreateDeploymentService().invoke(input), "デプロイできませんでした");
}

export async function archiveDeploymentAction(deploymentId: string) {
  return runAction(() => new ArchiveDeploymentService().invoke(deploymentId), "デプロイを停止できませんでした");
}

export async function promoteDeploymentAction(deploymentId: string) {
  return runAction(() => new PromoteDeploymentService().invoke(deploymentId), "Productionへ公開できませんでした");
}

export async function rollbackDeploymentAction(deploymentId: string) {
  return runAction(() => new RollbackDeploymentService().invoke(deploymentId), "Rollbackできませんでした");
}

export async function listDeploymentApiKeysAction(deploymentId: string) {
  return runAction(() => new DeploymentCredentialsService().listApiKeys(deploymentId), "API Keyの一覧を取得できませんでした");
}

export async function createDeploymentApiKeyAction(deploymentId: string, input: CreateDeploymentCredentialInput) {
  return runAction(() => new DeploymentCredentialsService().createApiKey(deploymentId, input), "API Keyを作成できませんでした");
}

export async function revokeDeploymentApiKeyAction(id: string) {
  return runAction(() => new DeploymentCredentialsService().revokeApiKey(id), "API Keyを無効化できませんでした");
}

export async function listDeploymentWebhooksAction(deploymentId: string) {
  return runAction(() => new DeploymentCredentialsService().listWebhooks(deploymentId), "Webhookの一覧を取得できませんでした");
}

export async function createDeploymentWebhookAction(deploymentId: string, input: CreateDeploymentCredentialInput) {
  return runAction(() => new DeploymentCredentialsService().createWebhook(deploymentId, input), "Webhookを作成できませんでした");
}

export async function revokeDeploymentWebhookAction(id: string) {
  return runAction(() => new DeploymentCredentialsService().revokeWebhook(id), "Webhookを無効化できませんでした");
}
