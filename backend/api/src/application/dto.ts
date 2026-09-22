import type {
  Prisma,
  agent_versions,
  agents,
  approvals,
  audit_logs,
  connections,
  connectors,
  agent_builds,
  agent_connection_links,
  agent_environment_configs,
  deployments,
  eval_cases,
  eval_runs,
  external_jobs,
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
  builder_projects,
  builder_runs,
  builder_steps,
  capability_plans,
  capability_gaps,
  human_actions,
  builder_discovery_sources,
  builder_change_sets,
  builder_validation_runs,
  builder_releases,
} from "@prisma/client";
import type {
  AgentDto,
  AgentBuildDto,
  AgentConnectionLinkDto,
  AgentEnvironmentConfigDto,
  AgentManifest,
  AgentVersionDto,
  ApprovalDto,
  ApprovalStatus,
  AuditLogDto,
  ConnectionDto,
  ConnectorDto,
  ConnectionScope,
  DeploymentDto,
  EvalCaseDto,
  EvalExpectations,
  EvalRunDto,
  MemberRole,
  ManagedRuntimeProvisioningStatus,
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
  BuilderProjectDto,
  BuilderRunDto,
  BuilderReleaseDto,
  BuilderStepDto,
  CapabilityPlanDto,
  CapabilityGapDto,
  HumanActionDto,
  BuilderDiscoverySourceDto,
  BuilderChangeSetDto,
  BuilderValidationRunDto,
} from "@agent-studio/contracts";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const toBuilderStepDto = (step: builder_steps): BuilderStepDto => ({
  id: step.id,
  kind: step.kind,
  status: step.status as BuilderStepDto["status"],
  attempts: step.attempts,
  error_class: step.error_class,
  error: step.error,
  started_at: iso(step.started_at),
  finished_at: iso(step.finished_at),
});

export const toBuilderRunDto = (run: builder_runs & { steps: builder_steps[] }): BuilderRunDto => ({
  id: run.id,
  attempt: run.attempt,
  status: run.status as BuilderRunDto["status"],
  correlation_id: run.correlation_id,
  error_class: run.error_class,
  error: run.error,
  error_fingerprint: run.error_fingerprint,
  retryable: run.retryable,
  next_action: run.next_action,
  not_before: iso(run.not_before),
  last_evidence_id: run.last_evidence_id,
  started_at: iso(run.started_at),
  finished_at: iso(run.finished_at),
  created_at: run.created_at.toISOString(),
  steps: run.steps.map(toBuilderStepDto),
});

export const toCapabilityPlanDto = (plan: capability_plans): CapabilityPlanDto => ({
  id: plan.id,
  version: plan.version,
  requirements: plan.requirements as unknown as CapabilityPlanDto["requirements"],
  graph: plan.graph as unknown as CapabilityPlanDto["graph"],
  risks: plan.risks as string[],
  execution_locations: plan.execution_locations as string[],
  created_at: plan.created_at.toISOString(),
});

export const toCapabilityGapDto = (gap: capability_gaps): CapabilityGapDto => ({
  id: gap.id,
  requirement: gap.requirement,
  gap_type: gap.gap_type as CapabilityGapDto["gap_type"],
  resolution_strategy: gap.resolution_strategy as CapabilityGapDto["resolution_strategy"],
  status: gap.status as CapabilityGapDto["status"],
  detail: gap.detail,
});

export const toHumanActionDto = (action: human_actions): HumanActionDto => ({
  id: action.id,
  type: action.type as HumanActionDto["type"],
  title: action.title,
  reason: action.reason,
  assignee_role: action.assignee_role as HumanActionDto["assignee_role"],
  fields: action.fields as unknown as HumanActionDto["fields"],
  instructions: action.instructions as string[],
  resume_condition: action.resume_condition,
  response: action.response as HumanActionDto["response"],
  status: action.status as HumanActionDto["status"],
  completed_at: iso(action.completed_at),
  expires_at: iso(action.expires_at),
  created_at: action.created_at.toISOString(),
});

/** Runtimeのcommand line・一時path・外部応答本文をBuilder画面/APIへ露出しない。詳細はRuntimeログだけに残す。 */
const publicValidationError = (suite: string, error: string | null): string | null => {
  if (!error) return null;
  if (suite === "code_workspace") {
    if (/401 Unauthorized|ジョブ限定認証が無効/i.test(error)) {
      return "Code Agentのジョブ限定認証が無効です。Runtime用の短期認証を再発行してから再実行してください";
    }
    if (/clone|Repository/i.test(error)) return "Git Repositoryを取得できませんでした。専用Git Connectionの読み取り権限を確認してください";
    return "Code Workspaceの隔離実行に失敗しました。詳細はRuntimeログで確認してください";
  }
  return error.slice(0, 500);
};

export const toBuilderProjectDto = (
  project: builder_projects & {
    plans: capability_plans[];
    gaps: capability_gaps[];
    human_actions: human_actions[];
    discovery_sources: builder_discovery_sources[];
    change_sets: builder_change_sets[];
    validation_runs: builder_validation_runs[];
    releases: builder_releases[];
    runs: (builder_runs & { steps: builder_steps[] })[];
  },
): BuilderProjectDto => ({
  id: project.id,
  agent_id: project.agent_id,
  request: project.request,
  target: project.target as BuilderProjectDto["target"],
  status: project.status as BuilderProjectDto["status"],
  created_by: project.created_by,
  created_at: project.created_at.toISOString(),
  updated_at: project.updated_at.toISOString(),
  completed_at: iso(project.completed_at),
  latest_plan: project.plans[0] ? toCapabilityPlanDto(project.plans[0]) : null,
  gaps: project.gaps.map(toCapabilityGapDto),
  human_actions: project.human_actions.map(toHumanActionDto),
  discovery_sources: project.discovery_sources.map((source): BuilderDiscoverySourceDto => ({
    id: source.id,
    kind: source.kind,
    title: source.title,
    spec_version: source.spec_version,
    source_url: source.source_url,
    content_hash: source.content_hash,
    metadata: source.metadata,
    created_at: source.created_at.toISOString(),
  })),
  change_sets: project.change_sets.map((change): BuilderChangeSetDto => ({
    id: change.id,
    kind: change.kind,
    status: change.status as BuilderChangeSetDto["status"],
    summary: change.summary,
    risk: change.risk as BuilderChangeSetDto["risk"],
    artifacts: change.artifacts as unknown as BuilderChangeSetDto["artifacts"],
    source_hash: change.source_hash,
    created_at: change.created_at.toISOString(),
  })),
  validation_runs: project.validation_runs.map((validation): BuilderValidationRunDto => ({
    id: validation.id,
    suite: validation.suite as BuilderValidationRunDto["suite"],
    environment: validation.environment as BuilderValidationRunDto["environment"],
    status: validation.status as BuilderValidationRunDto["status"],
    evidence: validation.evidence,
    error_class: validation.error_class,
    error: publicValidationError(validation.suite, validation.error),
    created_at: validation.created_at.toISOString(),
    finished_at: iso(validation.finished_at),
  })),
  releases: project.releases.map((release): BuilderReleaseDto => ({
    id: release.id,
    status: release.status as BuilderReleaseDto["status"],
    agent_id: release.agent_id,
    build_id: release.build_id,
    preview_deployment_id: release.preview_deployment_id,
    preview_run_id: release.preview_run_id,
    production_deployment_id: release.production_deployment_id,
    production_run_id: release.production_run_id,
    rollback_target_deployment_id: release.rollback_target_deployment_id,
    config_hash: release.config_hash,
    required_tools: release.required_tools,
    created_at: release.created_at.toISOString(),
    finished_at: iso(release.finished_at),
  })),
  runs: project.runs.map(toBuilderRunDto),
});

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

/** 設定値を能力へ紐づける前に保存された解決結果にも variables を持たせる。 */
const toCapabilityResolution = (raw: unknown): AgentDto["capability_resolution"] => {
  const resolution = (raw ?? {}) as AgentDto["capability_resolution"];
  return {
    ...resolution,
    requirements: (resolution.requirements ?? []).map((requirement) => ({ ...requirement, variables: requirement.variables ?? [] })),
    selected_tools: resolution.selected_tools ?? [],
    missing_variables: resolution.missing_variables ?? [],
    ready: resolution.ready ?? false,
  };
};

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
    project_brief: a.project_brief,
    capability_resolution: toCapabilityResolution(a.capability_resolution),
    browser_access: (a.browser_access === "public" ? "public" : "restricted") as AgentDto["browser_access"],
    browser_allowed_domains: Array.isArray(a.browser_allowed_domains) ? (a.browser_allowed_domains as string[]) : [],
    latest_version: a.latest_version,
    published_version: published.length > 0 ? Math.max(...published) : null,
    builder_project_id: null,
    builder_status: null,
    builder_error: null,
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
  connector_id: t.connector_id,
  created_at: t.created_at.toISOString(),
  ...(includeVersions ? { versions: [...(t.versions ?? [])].sort((x, y) => y.version - x.version).map(toToolVersionDto) } : {}),
});

export const toConnectionDto = (c: connections): ConnectionDto => ({
  id: c.id,
  name: c.name,
  description: c.description,
  connector_id: c.connector_id,
  scope: c.scope as ConnectionScope,
  runtime_id: c.runtime_id,
  runtime_secret_name: c.runtime_secret_name,
  header_name: c.header_name,
  metadata: c.metadata && typeof c.metadata === "object" && !Array.isArray(c.metadata) ? c.metadata as Record<string, unknown> : {},
  // runtime の接続先は値が顧客 AWS にあるため、Agent Studio からは設定済みか分からない
  has_secret: c.scope === "runtime" ? false : Boolean(c.secret_locator),
  status: c.status as ConnectionDto["status"],
  last_validated_at: iso(c.last_validated_at),
  expires_at: iso(c.expires_at),
  revoked_at: iso(c.revoked_at),
  created_at: c.created_at.toISOString(),
});

function externalJobRecords(value: Prisma.JsonValue | null): Record<string, unknown>[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const root = value as Record<string, unknown>;
  return [root, root.data, root.job, root.result].flatMap((item) => item && typeof item === "object" && !Array.isArray(item) ? [item as Record<string, unknown>] : []);
}

function externalJobString(value: Prisma.JsonValue | null, keys: string[]): string | null {
  for (const record of externalJobRecords(value)) {
    for (const key of keys) if (typeof record[key] === "string" && record[key]) return record[key];
  }
  return null;
}

function externalJobUrl(value: Prisma.JsonValue | null): string | null {
  const raw = externalJobString(value, ["permalink", "url", "post_url", "postUrl"]);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

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
  provisioning: r.provisioning_status
    ? {
        status: r.provisioning_status as ManagedRuntimeProvisioningStatus,
        step: r.provisioning_step ?? "準備を開始しています",
        progress: r.provisioning_progress,
        error: r.provisioning_error,
        can_retry: r.provisioning_status === "failed",
        started_at: iso(r.provisioning_started_at),
        completed_at: iso(r.provisioning_completed_at),
      }
    : null,
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
  d: deployments & { agent: agents; agent_version: agent_versions; runtime_profile: runtime_profiles; build?: agent_builds | null },
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
  build_id: d.build_id,
  build_number: d.build?.build_number ?? null,
  promoted_from_id: d.promoted_from_id,
  stage: d.stage as Stage,
  status: d.status as DeploymentDto["status"],
  health_status: d.health_status as DeploymentDto["health_status"],
  created_by: d.created_by,
  created_at: d.created_at.toISOString(),
});

export const toConnectorDto = (
  connector: connectors & { tools: (tools & { versions?: tool_versions[] })[] },
): ConnectorDto => ({
  id: connector.id,
  key: connector.key,
  name: connector.name,
  description: connector.description,
  adapter: connector.adapter as ConnectorDto["adapter"],
  base_url: connector.base_url,
  auth_type: connector.auth_type as ConnectorDto["auth_type"],
  created_at: connector.created_at.toISOString(),
  tools: connector.tools.map((tool) => toToolDto(tool, Boolean(tool.versions))),
});

export const toAgentConnectionLinkDto = (
  link: agent_connection_links & { connector: connectors; connection: connections },
): AgentConnectionLinkDto => ({
  id: link.id,
  stage: link.stage as AgentConnectionLinkDto["stage"],
  connector: { id: link.connector.id, key: link.connector.key, name: link.connector.name },
  connection: {
    id: link.connection.id,
    name: link.connection.name,
    status: link.connection.status as ConnectionDto["status"],
    has_secret: link.connection.scope === "runtime" ? false : Boolean(link.connection.secret_locator),
  },
  allowed_capabilities: link.allowed_capabilities as string[],
});

export const toAgentEnvironmentConfigDto = (config: agent_environment_configs): AgentEnvironmentConfigDto => ({
  stage: config.stage as AgentEnvironmentConfigDto["stage"],
  variables: config.variables as Record<string, string>,
});

export const toAgentBuildDto = (build: agent_builds): AgentBuildDto => ({
  id: build.id,
  build_number: build.build_number,
  status: build.status as AgentBuildDto["status"],
  agent_version_id: build.agent_version_id,
  runtime_profile_id: build.runtime_profile_id,
  resolution: build.resolution as unknown as AgentBuildDto["resolution"],
  build_log: build.build_log as unknown as AgentBuildDto["build_log"],
  created_at: build.created_at.toISOString(),
});

export type RunWithRelations = runs & {
  deployment: deployments & { agent: agents; agent_version: agent_versions; runtime_profile: runtime_profiles };
  external_jobs: external_jobs[];
};

export const toRunDto = (r: RunWithRelations): RunDto => ({
  id: r.id,
  status: r.status as RunStatus,
  outcome: r.outcome as RunDto["outcome"],
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
  requested_by_email: null,
  usage: (r.usage as RunDto["usage"]) ?? null,
  created_at: r.created_at.toISOString(),
  started_at: iso(r.started_at),
  finished_at: iso(r.finished_at),
  external_jobs: r.external_jobs.map((job) => ({
    id: job.id,
    provider_job_id: job.provider_job_id,
    source_tool: job.source_tool,
    status: job.status as RunDto["external_jobs"][number]["status"],
    attempts: job.attempts,
    last_checked_at: iso(job.last_checked_at),
    provider_post_id: externalJobString(job.response, ["post_id", "postId", "tweet_id", "tweetId"]),
    permalink: externalJobUrl(job.response),
  })),
});

export const runInclude = {
  deployment: { include: { agent: true, agent_version: true, runtime_profile: true } },
  external_jobs: { orderBy: { created_at: "asc" as const } },
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
  run_id: a.run_id,
  source: a.source,
  tool: a.tool,
  args_preview: a.args_preview,
  reason: a.reason,
  status: a.status as ApprovalStatus,
  requested_at: a.requested_at.toISOString(),
  expires_at: a.expires_at.toISOString(),
  decided_by: a.decided_by,
  decided_at: iso(a.decided_at),
  comment: a.comment,
  auto_approved: a.auto_approved,
  auto_approval_policy_id: a.auto_approval_policy_id,
  auto_approval_policy_version: a.auto_approval_policy_version,
  auto_approval_reason: a.auto_approval_reason,
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
