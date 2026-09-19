"use server";

import type { CreateEvalCaseInput } from "@agent-studio/contracts";
import { runAction } from "@/lib/api/run-action";
import {
  CreateEvalCaseService,
  DeleteEvalCaseService,
  ListEvalCasesService,
  ListEvalRunsService,
  StartEvalRunService,
} from "@/lib/services/evals";

export async function listEvalCasesAction(agentId: string) {
  return runAction(() => new ListEvalCasesService().invoke(agentId), "テストケースを取得できませんでした");
}

export async function createEvalCaseAction(agentId: string, input: CreateEvalCaseInput) {
  return runAction(() => new CreateEvalCaseService().invoke(agentId, input), "テストケースを追加できませんでした");
}

export async function deleteEvalCaseAction(caseId: string) {
  return runAction(() => new DeleteEvalCaseService().invoke(caseId), "テストケースを削除できませんでした");
}

export async function listEvalRunsAction(agentId: string) {
  return runAction(() => new ListEvalRunsService().invoke(agentId), "テストの結果を取得できませんでした");
}

export async function startEvalRunAction(agentId: string, input: { deployment_id: string }) {
  return runAction(() => new StartEvalRunService().invoke(agentId, input), "テストを開始できませんでした");
}
