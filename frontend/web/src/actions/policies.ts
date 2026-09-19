"use server";

import type { CreatePolicyInput, UpdatePolicyInput } from "@agent-studio/contracts";
import { runAction } from "@/lib/api/run-action";
import {
  CreatePolicyService,
  DeletePolicyService,
  ListPoliciesService,
  UpdatePolicyService,
} from "@/lib/services/policies";

export async function listPoliciesAction() {
  return runAction(() => new ListPoliciesService().invoke(), "ポリシーの一覧を取得できませんでした");
}

export async function createPolicyAction(input: CreatePolicyInput) {
  return runAction(() => new CreatePolicyService().invoke(input), "ポリシーを作成できませんでした");
}

export async function updatePolicyAction(id: string, input: UpdatePolicyInput) {
  return runAction(() => new UpdatePolicyService().invoke(id, input), "ポリシーを更新できませんでした");
}

export async function deletePolicyAction(id: string) {
  return runAction(() => new DeletePolicyService().invoke(id), "ポリシーを削除できませんでした");
}
