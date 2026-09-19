import type {
  agent_versions,
  agents,
  approvals,
  audit_logs,
  connections,
  deployments,
  eval_cases,
  eval_runs,
  organizations,
  policies,
  run_events,
  runs,
  runtime_profiles,
  runtimes,
  tool_versions,
  tools,
  workflow_runs,
  workflows,
} from "@prisma/client";
import type {
  AgentDto,
  AgentManifest,
  AgentVersionDto,
  ApprovalDto,
  ApprovalStatus,
  AuditLogDto,
  ConnectionDto,
  ConnectionScope,
  DeploymentDto,
  EvalCaseDto,
  EvalExpectations,
  EvalRunDto,
  MemberRole,
  NetworkPolicy,
  OpenAiTemplate,
  OrganizationDto,
  Policy,
  PolicyDto,
  ProvisioningType,
  RunDto,
  RunEventDto,
  RunEventType,
  RunStatus,
  RuntimeDto,
  RuntimeProfileDto,
  RuntimeProfileType,
  RuntimeStatus,
  RuntimeSummaryDto,
  RuntimeToolCatalogEntry,
  Stage,
  ToolDto,
  ToolExecutionLocation,
  ToolRisk,
  ToolVersionDto,
  ToolVersionSpec,
  WorkflowDefinition,
  WorkflowDto,
  WorkflowRunDto,
  WorkflowRunStatus,
} from "@agent-studio/contracts";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const toOrganizationDto = (o: organizations): OrganizationDto => ({
  id: o.id,
  slug: o.slug,
  name: o.name,
  status: o.status as OrganizationDto["status"],
  created_at: o.created_at.toISOString(),
});

export const toAgentVersionDto = (v: agent_versions): AgentVersionDto => ({
  id: v.id,
  version: v.version,
  status: v.status as AgentVersionDto["status"],
  manifest: v.manifest as unknown as AgentManifest,
  manifest_yaml: v.manifest_yaml,
  created_by: v.created_by,
  created_at: v.created_at.toISOString(),
  published_at: iso(v.published_at),
});

export const toAgentDto = (
  a: agents & { versions?: agent_versions[] | Pick<agent_versions, "status" | "version">[] },
  includeVersions = false,
): AgentDto => {
  const published = (a.versions ?? []).filter((v) => v.status === "published").map((v) => v.version);
  return {
    id: a.id,
    key: a.key,
    name: a.name,
    description: a.description,
    latest_version: a.latest_version,
    published_version: published.length > 0 ? Math.max(...published) : null,
    created_at: a.created_at.toISOString(),
    updated_at: a.updated_at.toISOString(),
    ...(includeVersions
      ? { versions: [...((a.versions ?? []) as agent_versions[])].sort((x, y) => y.version - x.version).map(toAgentVersionDto) }
      : {}),
  };
};

export const toToolVersionDto = (v: tool_versions): ToolVersionDto => ({
  id: v.id,
  version: v.version,
  spec: v.spec as unknown as ToolVersionSpec,
  created_at: v.created_at.toISOString(),
});

export const toToolDto = (t: tools & { versions?: tool_versions[] }, includeVersions = false): ToolDto => ({
  id: t.id,
  name: t.name,
  display_name: t.display_name,
  execution_location: t.execution_location as ToolExecutionLocation,
  risk: t.risk as ToolRisk,
  latest_version: t.latest_version,
  created_at: t.created_at.toISOString(),
  ...(includeVersions ? { versions: [...(t.versions ?? [])].sort((x, y) => y.version - x.version).map(toToolVersionDto) } : {}),
});

export const toConnectionDto = (c: connections): ConnectionDto => ({
  id: c.id,
  name: c.name,
  description: c.description,
  scope: c.scope as ConnectionScope,
  runtime_id: c.runtime_id,
  runtime_secret_name: c.runtime_secret_name,
  header_name: c.header_name,
  // runtime の接続先は値が顧客 AWS にあるため、Agent Studio からは設定済みか分からない
  has_secret: c.scope === "runtime" ? false : Boolean(c.secret_locator),
  created_at: c.created_at.toISOString(),
});

export const toPolicyDto = (p: policies): PolicyDto => ({
  id: p.id,
  name: p.name,
  rule: p.rule as unknown as Policy,
  enabled: p.enabled,
  created_at: p.created_at.toISOString(),
  updated_at: p.updated_at.toISOString(),
});

export const toRuntimeSummaryDto = (r: runtimes): RuntimeSummaryDto => ({
  id: r.id,
  name: r.name,
  stage: r.stage as Stage,
  provisioning_type: r.provisioning_type as ProvisioningType,
  status: r.status as RuntimeStatus,
});

export const toRuntimeDto = (r: runtimes): RuntimeDto => ({
  ...toRuntimeSummaryDto(r),
  aws_account_id: r.aws_account_id,
  aws_region: r.aws_region,
  expected_role_name: r.expected_role_name,
  controller_version: r.controller_version,
  last_heartbeat_at: iso(r.last_heartbeat_at),
  registered_at: iso(r.registered_at),
  tools: ((r.tool_catalog as unknown as RuntimeToolCatalogEntry[]) ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    risk: t.risk,
    reads_untrusted_content: t.reads_untrusted_content,
  })),
  created_at: r.created_at.toISOString(),
});

export const toRuntimeProfileDto = (p: runtime_profiles & { runtime?: runtimes | null }): RuntimeProfileDto => ({
  id: p.id,
  key: p.key,
  name: p.name,
  type: p.type as RuntimeProfileType,
  template: (p.template as OpenAiTemplate | null) ?? null,
  network: (p.network as unknown as NetworkPolicy | null) ?? null,
  runtime: p.runtime ? toRuntimeSummaryDto(p.runtime) : null,
  created_at: p.created_at.toISOString(),
});

export const toDeploymentDto = (
  d: deployments & { agent: agents; agent_version: agent_versions; runtime_profile: runtime_profiles },
): DeploymentDto => ({
  id: d.id,
  agent: { id: d.agent.id, key: d.agent.key, name: d.agent.name },
  agent_version: d.agent_version.version,
  agent_version_id: d.agent_version_id,
  runtime_profile: {
    id: d.runtime_profile.id,
    key: d.runtime_profile.key,
    name: d.runtime_profile.name,
    type: d.runtime_profile.type as RuntimeProfileType,
  },
  stage: d.stage as Stage,
  status: d.status as DeploymentDto["status"],
  created_by: d.created_by,
  created_at: d.created_at.toISOString(),
});

export type RunWithRelations = runs & {
  deployment: deployments & { agent: agents; agent_version: agent_versions; runtime_profile: runtime_profiles };
};

export const toRunDto = (r: RunWithRelations): RunDto => ({
  id: r.id,
  status: r.status as RunStatus,
  input: r.input,
  output: r.output,
  error: r.error,
  deployment: { id: r.deployment.id, stage: r.deployment.stage as Stage },
  agent: {
    id: r.deployment.agent.id,
    key: r.deployment.agent.key,
    name: r.deployment.agent.name,
    version: r.deployment.agent_version.version,
  },
  runtime_profile: {
    id: r.deployment.runtime_profile.id,
    key: r.deployment.runtime_profile.key,
    name: r.deployment.runtime_profile.name,
    type: r.deployment.runtime_profile.type as RuntimeProfileType,
  },
  requested_by: r.requested_by,
  usage: (r.usage as RunDto["usage"]) ?? null,
  created_at: r.created_at.toISOString(),
  started_at: iso(r.started_at),
  finished_at: iso(r.finished_at),
});

export const runInclude = {
  deployment: { include: { agent: true, agent_version: true, runtime_profile: true } },
} as const;

export const toRunEventDto = (e: run_events): RunEventDto => ({
  seq: e.seq,
  type: e.type as RunEventType,
  summary: e.summary,
  data: e.data,
  created_at: e.created_at.toISOString(),
});

export const toApprovalDto = (a: approvals, agent: { id: string; name: string } | null): ApprovalDto => ({
  id: a.id,
  run_id: a.run_id ?? "",
  tool: a.tool,
  args_preview: a.args_preview,
  reason: a.reason,
  status: a.status as ApprovalStatus,
  requested_at: a.requested_at.toISOString(),
  expires_at: a.expires_at.toISOString(),
  decided_by: a.decided_by,
  decided_at: iso(a.decided_at),
  comment: a.comment,
  agent,
});

export const toWorkflowDto = (w: workflows): WorkflowDto => ({
  id: w.id,
  key: w.key,
  name: w.name,
  version: w.version,
  definition: w.definition as unknown as WorkflowDefinition,
  created_at: w.created_at.toISOString(),
});

export const toWorkflowRunDto = (r: workflow_runs & { workflow: workflows }): WorkflowRunDto => ({
  id: r.id,
  workflow: { id: r.workflow.id, key: r.workflow.key, name: r.workflow.name, version: r.workflow_version },
  status: r.status as WorkflowRunStatus,
  input: r.input,
  current_step: r.current_step,
  steps: r.steps as unknown as WorkflowRunDto["steps"],
  created_at: r.created_at.toISOString(),
  finished_at: iso(r.finished_at),
});

export const toEvalCaseDto = (c: eval_cases): EvalCaseDto => ({
  id: c.id,
  agent_id: c.agent_id,
  name: c.name,
  input: c.input,
  expectations: c.expectations as unknown as EvalExpectations,
  created_at: c.created_at.toISOString(),
});

export const toEvalRunDto = (r: eval_runs): EvalRunDto => ({
  id: r.id,
  agent_id: r.agent_id,
  deployment_id: r.deployment_id,
  status: r.status as EvalRunDto["status"],
  results: r.results as unknown as EvalRunDto["results"],
  created_at: r.created_at.toISOString(),
  finished_at: iso(r.finished_at),
});

export const toAuditLogDto = (l: audit_logs): AuditLogDto => ({
  id: l.id,
  actor_type: l.actor_type as AuditLogDto["actor_type"],
  actor_id: l.actor_id,
  actor_label: l.actor_label,
  action: l.action,
  target_type: l.target_type,
  target_id: l.target_id,
  result: l.result as AuditLogDto["result"],
  detail: l.detail,
  source_ip: l.source_ip,
  created_at: l.created_at.toISOString(),
});

export type { MemberRole, RunStatus };
