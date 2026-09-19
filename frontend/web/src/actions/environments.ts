"use server";

import type { CreateRuntimeProfileInput } from "@agent-studio/contracts";
import { runAction } from "@/lib/api/run-action";
import {
  CreateRuntimeProfileService,
  CreateSelfHostedEnvironmentService,
  DeleteRuntimeProfileService,
  ListRuntimeProfilesService,
  type CreateSelfHostedEnvironmentInput,
} from "@/lib/services/environments";

export async function listRuntimeProfilesAction() {
  return runAction(() => new ListRuntimeProfilesService().invoke(), "実行環境の一覧を取得できませんでした");
}

/** OpenAI の環境・実行環境なしの設定を作る */
export async function createRuntimeProfileAction(input: CreateRuntimeProfileInput) {
  return runAction(() => new CreateRuntimeProfileService().invoke(input), "実行環境を作成できませんでした");
}

/** AWS で実行する環境を作る（必要なら Runtime も作る） */
export async function createSelfHostedEnvironmentAction(input: CreateSelfHostedEnvironmentInput) {
  return runAction(() => new CreateSelfHostedEnvironmentService().invoke(input), "実行環境を作成できませんでした");
}

export async function deleteRuntimeProfileAction(id: string) {
  return runAction(() => new DeleteRuntimeProfileService().invoke(id), "実行環境を削除できませんでした");
}
