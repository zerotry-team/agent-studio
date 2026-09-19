"use server";

import type { CreateRunInput } from "@agent-studio/contracts";
import { runAction } from "@/lib/api/run-action";
import type { RunListQuery } from "@/lib/repositories";
import {
  CancelRunService,
  GetRunEventsService,
  GetRunService,
  ListRunArtifactsService,
  ListRunsService,
  SendRunMessageService,
  StartRunService,
} from "@/lib/services/runs";

export async function listRunsAction(query: RunListQuery = {}) {
  return runAction(() => new ListRunsService().invoke(query), "実行履歴を取得できませんでした");
}

export async function getRunAction(runId: string) {
  return runAction(() => new GetRunService().invoke(runId), "実行の情報を取得できませんでした");
}

/** after_seq より後のイベントと、実行の最新の状態 */
export async function getRunEventsAction(runId: string, afterSeq: number) {
  return runAction(() => new GetRunEventsService().invoke(runId, afterSeq), "実行の経過を取得できませんでした");
}

export async function startRunAction(input: CreateRunInput) {
  return runAction(() => new StartRunService().invoke(input), "実行を開始できませんでした");
}

export async function sendRunMessageAction(runId: string, input: { input: string }) {
  return runAction(() => new SendRunMessageService().invoke(runId, input), "メッセージを送れませんでした");
}

export async function cancelRunAction(runId: string) {
  return runAction(() => new CancelRunService().invoke(runId), "実行を中止できませんでした");
}

export async function listRunArtifactsAction(runId: string) {
  return runAction(() => new ListRunArtifactsService().invoke(runId), "成果物を取得できませんでした");
}
