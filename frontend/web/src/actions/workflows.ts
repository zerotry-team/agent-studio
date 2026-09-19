"use server";

import type { CreateWorkflowInput, WorkflowDefinition } from "@agent-studio/contracts";
import { runAction } from "@/lib/api/run-action";
import {
  CreateWorkflowService,
  GetWorkflowRunService,
  GetWorkflowService,
  ListWorkflowRunsService,
  ListWorkflowsService,
  StartWorkflowRunService,
  UpdateWorkflowService,
} from "@/lib/services/workflows";

export async function listWorkflowsAction() {
  return runAction(() => new ListWorkflowsService().invoke(), "ワークフローの一覧を取得できませんでした");
}

export async function getWorkflowAction(id: string) {
  return runAction(() => new GetWorkflowService().invoke(id), "ワークフローの情報を取得できませんでした");
}

export async function createWorkflowAction(input: CreateWorkflowInput) {
  return runAction(() => new CreateWorkflowService().invoke(input), "ワークフローを作成できませんでした");
}

export async function updateWorkflowAction(id: string, input: { name: string; definition: WorkflowDefinition }) {
  return runAction(() => new UpdateWorkflowService().invoke(id, input), "ワークフローを保存できませんでした");
}

export async function startWorkflowRunAction(workflowId: string, input: { input: string }) {
  return runAction(() => new StartWorkflowRunService().invoke(workflowId, input), "ワークフローを開始できませんでした");
}

export async function listWorkflowRunsAction(query: { workflow_id?: string } = {}) {
  return runAction(() => new ListWorkflowRunsService().invoke(query), "ワークフローの実行履歴を取得できませんでした");
}

export async function getWorkflowRunAction(runId: string) {
  return runAction(() => new GetWorkflowRunService().invoke(runId), "ワークフローの実行状況を取得できませんでした");
}
