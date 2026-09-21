"use server";

import { runAction } from "@/lib/api/run-action";
import {
  CreateAgentProjectService,
  CreatePreviewService,
  CreateAgentService,
  CreateAgentVersionService,
  GenerateManifestService,
  GetAgentProjectService,
  GetAgentService,
  ListAgentsService,
  PublishAgentVersionService,
  LinkAgentConnectionService,
  SetBrowserAccessService,
  SetAgentEnvironmentService,
  ValidateManifestService,
} from "@/lib/services/agents";
import type { CreateAgentProjectInput, LinkAgentConnectionInput, SetAgentEnvironmentInput , SetBrowserAccessInput } from "@agent-studio/contracts";

export async function listAgentsAction() {
  return runAction(() => new ListAgentsService().invoke(), "エージェントの一覧を取得できませんでした");
}

export async function createAgentProjectAction(input: CreateAgentProjectInput) {
  return runAction(() => new CreateAgentProjectService().invoke(input), "Agent Projectを作成できませんでした");
}

export async function getAgentProjectAction(id: string) {
  return runAction(() => new GetAgentProjectService().invoke(id), "Agent Projectを取得できませんでした");
}

export async function setBrowserAccessAction(id: string, input: SetBrowserAccessInput) {
  return runAction(() => new SetBrowserAccessService().invoke(id, input), "ブラウザの接続範囲を保存できませんでした");
}

export async function linkAgentConnectionAction(id: string, input: LinkAgentConnectionInput) {
  return runAction(() => new LinkAgentConnectionService().invoke(id, input), "Connectionを設定できませんでした");
}

export async function setAgentEnvironmentAction(id: string, input: SetAgentEnvironmentInput) {
  return runAction(() => new SetAgentEnvironmentService().invoke(id, input), "Variablesを設定できませんでした");
}

export async function createPreviewAction(id: string) {
  return runAction(() => new CreatePreviewService().invoke(id), "Previewを作成できませんでした");
}

export async function getAgentAction(id: string) {
  return runAction(() => new GetAgentService().invoke(id), "エージェントの情報を取得できませんでした");
}

export async function createAgentAction(input: { manifest: string }) {
  return runAction(() => new CreateAgentService().invoke(input), "エージェントを保存できませんでした");
}

export async function generateManifestAction(input: { description: string }) {
  return runAction(() => new GenerateManifestService().invoke(input), "エージェントの定義を生成できませんでした");
}

export async function validateManifestAction(input: { manifest: string }) {
  return runAction(() => new ValidateManifestService().invoke(input), "定義をチェックできませんでした");
}

export async function createAgentVersionAction(agentId: string, input: { manifest: string }) {
  return runAction(() => new CreateAgentVersionService().invoke(agentId, input), "新しいバージョンを保存できませんでした");
}

export async function publishAgentVersionAction(agentId: string, version: number) {
  return runAction(() => new PublishAgentVersionService().invoke(agentId, version), "バージョンを公開できませんでした");
}
