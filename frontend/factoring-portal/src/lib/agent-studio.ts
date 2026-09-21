import "server-only";
import type { ApprovalDto, MeDto, WorkflowDto, WorkflowRunDto } from "@agent-studio/contracts";
import { approvalDecision, assertApprovalConfiguration, parseDemoApprovalMode } from "./approval-mode";
import type { ScreeningInput, ScreeningView } from "./types";

const API_BASE = (process.env.AGENT_STUDIO_API_URL ?? "http://127.0.0.1:3200").replace(/\/+$/, "");
const API_PREFIX = "/api/v1";
const OPERATOR_EMAIL = process.env.DEMO_OPERATOR_EMAIL ?? "owner@sample-a.example";
const APPROVAL_MODE = parseDemoApprovalMode(process.env.DEMO_APPROVAL_MODE);
const ALLOW_EXTERNAL_PUBLISH = process.env.DEMO_ALLOW_EXTERNAL_PUBLISH === "true";

assertApprovalConfiguration(APPROVAL_MODE, ALLOW_EXTERNAL_PUBLISH);

let cachedOrganizationId: string | null = null;

function accessToken(): string {
  const configured = process.env.AGENT_STUDIO_SERVICE_TOKEN?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AGENT_STUDIO_SERVICE_TOKEN が設定されていません");
  }
  return `dev:${OPERATOR_EMAIL}`;
}

async function rawRequest<T>(path: string, init: RequestInit = {}, organizationId?: string): Promise<T> {
  const response = await fetch(`${API_BASE}${API_PREFIX}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${accessToken()}`,
      "content-type": "application/json",
      ...(organizationId ? { "x-organization-id": organizationId } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    let message = `Agent Studio API error (${response.status})`;
    try {
      const body = JSON.parse(text) as { error?: { message?: string }; message?: string };
      message = body.error?.message ?? body.message ?? message;
    } catch {
      // HTMLや空レスポンスはステータスだけを使う。
    }
    throw new Error(message);
  }
  return (text ? JSON.parse(text) : null) as T;
}

async function organizationId(): Promise<string> {
  if (cachedOrganizationId) return cachedOrganizationId;
  const configured = process.env.AGENT_STUDIO_ORGANIZATION_ID?.trim();
  if (configured) {
    cachedOrganizationId = configured;
    return configured;
  }
  const me = await rawRequest<MeDto>("/me");
  const membership = me.memberships.find((item) => item.organization.name.includes("Sample A")) ?? me.memberships[0];
  if (!membership) throw new Error("デモ用の組織が見つかりません");
  cachedOrganizationId = membership.organization.id;
  return cachedOrganizationId;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  return rawRequest<T>(path, init, await organizationId());
}

function parseObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function autoDecideApprovals(run: WorkflowRunDto): Promise<boolean> {
  if (APPROVAL_MODE === "manual") return false;
  const pending = await request<ApprovalDto[]>("/approvals?status=pending");
  const approvalIds = new Set(run.steps.flatMap((step) => step.approval_id ? [step.approval_id] : []));
  const childRunIds = new Set(run.steps.flatMap((step) => step.run_id ? [step.run_id] : []));
  const relevant = pending.filter((approval) => approvalIds.has(approval.id) || (approval.run_id !== null && childRunIds.has(approval.run_id)));
  for (const approval of relevant) {
    const decision = approvalDecision(approval, APPROVAL_MODE, ALLOW_EXTERNAL_PUBLISH);
    if (decision === "wait") continue;
    await request(`/approvals/${encodeURIComponent(approval.id)}/decision`, {
      method: "POST",
      body: JSON.stringify({
        decision,
        comment: decision === "approve"
          ? "デモ用の自動承認設定により実行"
          : "審査結果だけを返す安全デモのため外部公開は実行しない",
      }),
    });
  }
  return relevant.length > 0;
}

export async function startScreening(input: ScreeningInput): Promise<ScreeningView> {
  const workflows = await request<WorkflowDto[]>("/workflows");
  const workflow = workflows.find((item) => item.key.endsWith("-factoring"));
  if (!workflow) throw new Error("ファクタリング審査Workflowが見つかりません");
  const run = await request<WorkflowRunDto>(`/workflows/${encodeURIComponent(workflow.id)}/runs`, {
    method: "POST",
    body: JSON.stringify({ input: JSON.stringify(input) }),
  });
  return toView(run);
}

export async function getScreening(runId: string): Promise<ScreeningView> {
  let run = await request<WorkflowRunDto>(`/workflow-runs/${encodeURIComponent(runId)}`);
  const decided = await autoDecideApprovals(run);
  if (decided) run = await request<WorkflowRunDto>(`/workflow-runs/${encodeURIComponent(runId)}`);
  return toView(run);
}

function toView(run: WorkflowRunDto): ScreeningView {
  const step = (key: string) => run.steps.find((item) => item.key === key);
  const evaluation = parseObject(step("evaluate-rules")?.output ?? null);
  const record = parseObject(step("record-result")?.output ?? null);
  const publicSummary = step("public-summary")?.output ?? null;
  const reasonCodes = Array.isArray(evaluation?.reason_codes)
    ? evaluation.reason_codes.filter((value): value is string => typeof value === "string")
    : [];
  const received = step("load-application")?.status === "completed";
  const documents = step("analyze-document")?.status === "completed" && step("check-compliance")?.status === "completed";
  const decision = step("evaluate-rules")?.status === "completed";
  const recorded = step("record-result")?.status === "completed" && record !== null;
  const failed = run.status === "failed";
  const phase = failed
    ? "failed"
    : run.status === "completed"
      ? "complete"
      : recorded
        ? "recording"
        : decision
          ? "deciding"
          : received
            ? "checking"
            : "received";

  return {
    id: run.id,
    status: failed ? "failed" : run.status === "completed" ? "completed" : "running",
    phase,
    progress: { received, documents, decision, recorded },
    decision: stringValue(evaluation?.decision_candidate),
    decisionCode: stringValue(evaluation?.decision_code),
    reasonCodes,
    ruleVersion: stringValue(evaluation?.rule_version),
    recorded,
    published: step("publish-result")?.status === "completed",
    publicText: publicSummary,
    message: failed ? "審査処理を完了できませんでした。入力内容を確認して、もう一度お試しください。" : null,
  };
}
