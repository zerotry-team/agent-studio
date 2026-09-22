import type {
  AgentVersionStatus,
  ApprovalStatus,
  DeploymentStatus,
  EvalRunDto,
  RunOutcome,
  RunStatus,
  RuntimeStatus,
  Stage,
  ToolRisk,
  WorkflowRunStatus,
} from "@agent-studio/contracts";
import { Badge } from "@/components/ui/badge";
import {
  AGENT_VERSION_STATUS,
  APPROVAL_STATUS,
  DEPLOYMENT_STATUS,
  EVAL_RESULT_STATUS,
  EVAL_RUN_STATUS,
  RUN_STATUS,
  RUNTIME_STATUS,
  STAGE_LABELS,
  TOOL_RISK,
  WORKFLOW_RUN_STATUS,
  WORKFLOW_STEP_STATUS,
  type WorkflowStepStatus,
} from "@/lib/utils/labels";

const ACTIVE_RUN: RunStatus[] = ["queued", "provisioning", "running"];

export function RunStatusBadge({ status, outcome }: { status: RunStatus; outcome?: RunOutcome }) {
  if (status === "completed" && outcome === "completed_with_errors") {
    return <Badge tone="warning" dot>完了（操作エラーあり）</Badge>;
  }
  const s = RUN_STATUS[status];
  return (
    <Badge tone={s.tone} dot pulse={ACTIVE_RUN.includes(status)}>
      {s.label}
    </Badge>
  );
}

export function RuntimeStatusBadge({ status }: { status: RuntimeStatus }) {
  const s = RUNTIME_STATUS[status];
  return (
    <Badge tone={s.tone} dot pulse={status === "pending" || status === "provisioning"}>
      {s.label}
    </Badge>
  );
}

export function ApprovalStatusBadge({ status }: { status: ApprovalStatus }) {
  const s = APPROVAL_STATUS[status];
  return (
    <Badge tone={s.tone} dot>
      {s.label}
    </Badge>
  );
}

export function DeploymentStatusBadge({ status }: { status: DeploymentStatus }) {
  const s = DEPLOYMENT_STATUS[status];
  return (
    <Badge tone={s.tone} dot>
      {s.label}
    </Badge>
  );
}

export function AgentVersionStatusBadge({ status }: { status: AgentVersionStatus }) {
  const s = AGENT_VERSION_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function WorkflowRunStatusBadge({ status }: { status: WorkflowRunStatus }) {
  const s = WORKFLOW_RUN_STATUS[status];
  return (
    <Badge tone={s.tone} dot pulse={status === "running"}>
      {s.label}
    </Badge>
  );
}

export function WorkflowStepStatusBadge({ status }: { status: WorkflowStepStatus }) {
  const s = WORKFLOW_STEP_STATUS[status];
  return (
    <Badge tone={s.tone} dot pulse={status === "running"}>
      {s.label}
    </Badge>
  );
}

export function EvalRunStatusBadge({ status }: { status: EvalRunDto["status"] }) {
  const s = EVAL_RUN_STATUS[status];
  return (
    <Badge tone={s.tone} dot pulse={status === "running"}>
      {s.label}
    </Badge>
  );
}

export function EvalResultStatusBadge({ status }: { status: EvalRunDto["results"][number]["status"] }) {
  const s = EVAL_RESULT_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function StageBadge({ stage }: { stage: Stage }) {
  return <Badge tone={stage === "production" ? "accent" : "neutral"}>{STAGE_LABELS[stage]}</Badge>;
}

export function ToolRiskBadge({ risk }: { risk: ToolRisk }) {
  const s = TOOL_RISK[risk];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
