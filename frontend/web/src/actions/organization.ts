"use server";

import type { CreateOrganizationInput } from "@agent-studio/contracts";
import { runAction } from "@/lib/api/run-action";
import {
  CreateOrganizationService,
  GetOpenAiSettingsService,
  GetOrganizationService,
  UpdateOpenAiSettingsService,
  UpdateOrganizationService,
  type UpdateOpenAiSettingsInput,
} from "@/lib/services/organization";

export async function getOrganizationAction() {
  return runAction(() => new GetOrganizationService().invoke(), "組織の情報を取得できませんでした");
}

export async function updateOrganizationAction(input: { name: string }) {
  return runAction(() => new UpdateOrganizationService().invoke(input), "組織の情報を保存できませんでした");
}

export async function getOpenAiSettingsAction() {
  return runAction(() => new GetOpenAiSettingsService().invoke(), "OpenAI の設定を取得できませんでした");
}

export async function updateOpenAiSettingsAction(input: UpdateOpenAiSettingsInput) {
  return runAction(() => new UpdateOpenAiSettingsService().invoke(input), "OpenAI の設定を保存できませんでした");
}

/** 運営管理者のみ */
export async function createOrganizationAction(input: CreateOrganizationInput) {
  return runAction(() => new CreateOrganizationService().invoke(input), "組織を作成できませんでした");
}
