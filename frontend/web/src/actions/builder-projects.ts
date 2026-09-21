"use server";

import type { BuilderMcpInput, BuilderOpenApiInput, CompleteBuilderHumanActionInput, CreateBuilderProjectInput } from "@agent-studio/contracts";
import { runAction } from "@/lib/api/run-action";
import {
  CancelBuilderProjectService,
  CompleteBuilderHumanActionService,
  ApproveBuilderProductionService,
  CreateBuilderProjectService,
  GetBuilderProjectService,
  ListBuilderProjectsService,
  ResumeBuilderProjectService,
  EnsureBuilderProjectAgentService,
  InspectBuilderOpenApiService,
  ApplyBuilderOpenApiService,
  InspectBuilderMcpService,
  ApplyBuilderMcpService,
} from "@/lib/services/builder-projects";

export async function listBuilderProjectsAction() {
  return runAction(() => new ListBuilderProjectsService().invoke(), "作成プロジェクトの一覧を取得できませんでした");
}
export async function getBuilderProjectAction(id: string) {
  return runAction(() => new GetBuilderProjectService().invoke(id), "作成プロジェクトを取得できませんでした");
}
export async function createBuilderProjectAction(input: CreateBuilderProjectInput) {
  return runAction(() => new CreateBuilderProjectService().invoke(input), "作成プロジェクトを開始できませんでした");
}
export async function resumeBuilderProjectAction(id: string) {
  return runAction(() => new ResumeBuilderProjectService().invoke(id), "作成プロジェクトを再開できませんでした");
}
export async function ensureBuilderProjectAgentAction(id: string) {
  return runAction(() => new EnsureBuilderProjectAgentService().invoke(id), "Agentへ移行できませんでした");
}
export async function cancelBuilderProjectAction(id: string) {
  return runAction(() => new CancelBuilderProjectService().invoke(id), "作成プロジェクトを中止できませんでした");
}
export async function completeBuilderHumanActionAction(input: { id: string; value: CompleteBuilderHumanActionInput }) {
  return runAction(() => new CompleteBuilderHumanActionService().invoke(input.id, input.value), "操作の完了を記録できませんでした");
}

export async function approveBuilderProductionAction(id: string) {
  return runAction(() => new ApproveBuilderProductionService().invoke(id), "Productionへ昇格できませんでした");
}
export async function inspectBuilderOpenApiAction(input: { projectId: string; value: BuilderOpenApiInput }) {
  return runAction(
    () => new InspectBuilderOpenApiService().invoke(input.projectId, input.value),
    "OpenAPI仕様を検査できませんでした",
  );
}
export async function applyBuilderOpenApiAction(input: { projectId: string; value: BuilderOpenApiInput }) {
  return runAction(
    () => new ApplyBuilderOpenApiService().invoke(input.projectId, input.value),
    "連携サービスを生成できませんでした",
  );
}
export async function inspectBuilderMcpAction(input: { projectId: string; value: BuilderMcpInput }) {
  return runAction(
    () => new InspectBuilderMcpService().invoke(input.projectId, input.value),
    "MCPサーバーを検査できませんでした",
  );
}
export async function applyBuilderMcpAction(input: { projectId: string; value: BuilderMcpInput }) {
  return runAction(
    () => new ApplyBuilderMcpService().invoke(input.projectId, input.value),
    "MCP連携を生成できませんでした",
  );
}
