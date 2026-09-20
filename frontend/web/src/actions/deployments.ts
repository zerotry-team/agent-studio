"use server";

import type { CreateDeploymentInput } from "@agent-studio/contracts";
import { runAction } from "@/lib/api/run-action";
import {
  ArchiveDeploymentService,
  CreateDeploymentService,
  ListDeploymentsService,
  PromoteDeploymentService,
  RollbackDeploymentService,
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
