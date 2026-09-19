"use server";

import { runAction } from "@/lib/api/run-action";
import {
  CreateAgentService,
  CreateAgentVersionService,
  GenerateManifestService,
  GetAgentService,
  ListAgentsService,
  PublishAgentVersionService,
  ValidateManifestService,
} from "@/lib/services/agents";

export async function listAgentsAction() {
  return runAction(() => new ListAgentsService().invoke(), "エージェントの一覧を取得できませんでした");
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
