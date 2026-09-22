"use server";

import type { CreateRuntimeInput } from "@agent-studio/contracts";
import { runAction } from "@/lib/api/run-action";
import {
  CreateRuntimeService,
  GetRuntimeService,
  IssueBootstrapTokenService,
  ListRuntimesService,
  RevokeRuntimeService,
  RetryManagedRuntimeProvisioningService,
  RotateEnvironmentKeyService,
} from "@/lib/services/runtimes";

export async function listRuntimesAction() {
  return runAction(() => new ListRuntimesService().invoke(), "Runtime の一覧を取得できませんでした");
}

export async function getRuntimeAction(id: string) {
  return runAction(() => new GetRuntimeService().invoke(id), "Runtime の情報を取得できませんでした");
}

export async function createRuntimeAction(input: CreateRuntimeInput) {
  return runAction(() => new CreateRuntimeService().invoke(input), "Runtime を作成できませんでした");
}

/** 登録用トークンを発行する（平文はこの応答でしか受け取れない） */
export async function issueBootstrapTokenAction(runtimeId: string) {
  return runAction(() => new IssueBootstrapTokenService().invoke(runtimeId), "登録用トークンを発行できませんでした");
}

export async function retryManagedRuntimeProvisioningAction(runtimeId: string) {
  return runAction(() => new RetryManagedRuntimeProvisioningService().invoke(runtimeId), "Runtimeの自動構築を再試行できませんでした");
}

export async function revokeRuntimeAction(runtimeId: string) {
  return runAction(() => new RevokeRuntimeService().invoke(runtimeId), "Runtime を失効できませんでした");
}

export async function rotateEnvironmentKeyAction(runtimeId: string) {
  return runAction(() => new RotateEnvironmentKeyService().invoke(runtimeId), "環境キーの入れ替えを開始できませんでした");
}
