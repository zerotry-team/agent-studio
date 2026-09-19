"use server";

import type { CreateToolInput, CreateToolVersionInput } from "@agent-studio/contracts";
import { runAction } from "@/lib/api/run-action";
import { CreateToolService, CreateToolVersionService, GetToolService, ListToolsService } from "@/lib/services/tools";

export async function listToolsAction() {
  return runAction(() => new ListToolsService().invoke(), "ツールの一覧を取得できませんでした");
}

export async function getToolAction(id: string) {
  return runAction(() => new GetToolService().invoke(id), "ツールの情報を取得できませんでした");
}

export async function createToolAction(input: CreateToolInput) {
  return runAction(() => new CreateToolService().invoke(input), "ツールを登録できませんでした");
}

export async function createToolVersionAction(toolId: string, input: CreateToolVersionInput) {
  return runAction(() => new CreateToolVersionService().invoke(toolId, input), "新しいバージョンを登録できませんでした");
}
