import type { Prisma } from "@prisma/client";
import {
  createEvalCaseSchema,
  parseManifest,
  parseToolRef,
  policySchema,
  stringifyManifest,
  type AgentDto,
  type AgentProjectDto,
  type AgentManifest,
  setBrowserAccessSchema,
  type CapabilityResolutionDto,
  type SetBrowserAccessInput,
  type AgentVersionDto,
  type CreateEvalCaseInput,
  type EvalCaseDto,
  type EvalRunDto,
  type GenerateManifestResultDto,
  type LinkAgentConnectionInput,
  type ManifestValidationDto,
  type SetAgentEnvironmentInput,
  type Policy,
  type ToolVersionSpec,
} from "@agent-studio/contracts";
import { conflict, notFound, preconditionFailed, validationError } from "../domain/errors.js";
import { resolveCapabilities } from "../domain/capability-resolver.js";
import type { ResolvedTool } from "../domain/manifest-compiler.js";
import { recordAudit } from "../infrastructure/audit.js";
import type { Tx } from "../infrastructure/db/tenant-db.js";
import type { GeneratedAgent } from "../infrastructure/llm/manifest-generator.js";
import { auditBy, requireRole, scopeOf, type MemberActor } from "./context.js";
import type { Deps } from "./deps.js";
import {
  toAgentBuildDto,
  toAgentConnectionLinkDto,
  toAgentDto,
  toAgentEnvironmentConfigDto,
  toAgentVersionDto,
  toDeploymentDto,
  toEvalCaseDto,
  toEvalRunDto,
} from "./dto.js";
import { createRunInTx } from "./runs.js";

/** Manifest のツール参照を、組織のツール（バージョン）に解決する */
export async function resolveTools(
  tx: Tx,
  organizationId: string,
  refs: string[],
): Promise<{ tools: ResolvedTool[]; errors: string[] }> {
  const errors: string[] = [];
  const tools: ResolvedTool[] = [];
  for (const ref of refs) {
    const { name, version } = parseToolRef(ref);
    const tool = await tx.tools.findUnique({ where: { organization_id_name: { organization_id: organizationId, name } } });
    if (!tool) {
      errors.push(`ツール ${name} が登録されていません`);
      continue;
    }
    const v = await tx.tool_versions.findFirst({
      where: { tool_id: tool.id, organization_id: organizationId, version: version ?? tool.latest_version },
    });
    if (!v) {
      errors.push(`ツール ${name} のバージョン ${version} がありません`);
      continue;
    }
    tools.push({
      tool_id: tool.id,
      tool_version_id: v.id,
      name,
      version: v.version,
      connector_id: tool.connector_id,
      spec: v.spec as unknown as ToolVersionSpec,
    });
  }
  return { tools, errors };
}

export class AgentService {
  constructor(private readonly deps: Deps) {}

  async list(actor: MemberActor): Promise<AgentDto[]> {
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const agents = await tx.agents.findMany({
        where: { organization_id: actor.organizationId },
        include: { versions: { select: { status: true, version: true } } },
        orderBy: { updated_at: "desc" },
      });
      return agents.map((a) => toAgentDto(a));
    });
  }

  /** ブラウザで接続してよい範囲を設定する。安全の境界なので業務の設定値とは分けて持つ */
  async setBrowserAccess(actor: MemberActor, agentId: string, raw: SetBrowserAccessInput): Promise<AgentDto> {
    requireRole(actor, "builder");
    const input = setBrowserAccessSchema.parse(raw);
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const agent = await tx.agents.findFirst({ where: { id: agentId, organization_id: actor.organizationId } });
      if (!agent) throw notFound("エージェント");
      const domains = input.access === "public" ? [] : [...new Set(input.allowed_domains.map((d) => d.trim().toLowerCase()))];
      const updated = await tx.agents.update({
        where: { id: agentId },
        data: { browser_access: input.access, browser_allowed_domains: domains },
        include: { versions: true },
      });
      // 保存と実行設定の更新を同じトランザクションで行う。既存Runのスナップショットは変更しない。
      const deployments = await tx.deployments.findMany({
        where: { organization_id: actor.organizationId, agent_id: agentId, status: "active" },
        include: { build: true },
      });
      if (deployments.some((deployment) => deployment.stage === "production")) requireRole(actor, "admin");
      const browserAccess = { access: input.access, allowed_domains: domains };
      const latestBuild = await tx.agent_builds.findFirst({ where: { agent_id: agentId }, orderBy: { build_number: "desc" } });
      let buildNumber = latestBuild?.build_number ?? 0;
      const replacementBuilds = new Map<string, string>();
      for (const deployment of deployments) {
        const config = deployment.compiled_config as Record<string, unknown>;
        if (JSON.stringify(config.browser_access) === JSON.stringify(browserAccess)) continue;
        let buildId = deployment.build_id;
        if (deployment.build) {
          buildId = replacementBuilds.get(deployment.build.id) ?? null;
          if (!buildId) {
            const build = await tx.agent_builds.create({
              data: {
                organization_id: actor.organizationId,
                agent_id: agentId,
                agent_version_id: deployment.agent_version_id,
                runtime_profile_id: deployment.runtime_profile_id,
                build_number: ++buildNumber,
                status: deployment.build.status,
                resolution: deployment.build.resolution as Prisma.InputJsonValue,
                compiled_config: { ...(deployment.build.compiled_config as Record<string, unknown>), browser_access: browserAccess } as Prisma.InputJsonValue,
                build_log: [{ type: "success", message: "保存したブラウザ接続範囲を反映しました" }],
                created_by: actor.userId,
              },
            });
            buildId = build.id;
            replacementBuilds.set(deployment.build.id, buildId);
          }
        }
        await tx.deployments.update({ where: { id: deployment.id }, data: { status: "superseded" } });
        const replacement = await tx.deployments.create({
          data: {
            organization_id: actor.organizationId,
            agent_id: agentId,
            agent_version_id: deployment.agent_version_id,
            runtime_profile_id: deployment.runtime_profile_id,
            build_id: buildId,
            promoted_from_id: deployment.id,
            stage: deployment.stage,
            health_status: deployment.health_status,
            compiled_config: { ...config, browser_access: browserAccess } as Prisma.InputJsonValue,
            created_by: actor.userId,
          },
        });
        await recordAudit(tx, auditBy(actor, {
          action: "deployment.browser_access.update", targetType: "deployment", targetId: replacement.id,
          detail: { previous_deployment_id: deployment.id, stage: deployment.stage, access: input.access, domains },
        }));
      }
      await recordAudit(
        tx,
        auditBy(actor, { action: "agent.browser_access", targetType: "agent", targetId: agentId, detail: { access: input.access, domains } }),
      );
      return toAgentDto(updated, true);
    });
  }

  async get(actor: MemberActor, id: string): Promise<AgentDto> {
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const agent = await tx.agents.findFirst({ where: { id, organization_id: actor.organizationId }, include: { versions: true } });
      if (!agent) throw notFound("エージェント");
      return toAgentDto(agent, true);
    });
  }

  /** 業務説明1つからAgent Projectを作る。YAMLは保存するが通常導線では表示しない。 */
  async createProject(actor: MemberActor, description: string): Promise<AgentDto> {
    requireRole(actor, "builder");
    const draft = await this.generate(actor, description);
    let manifest = this.parseOrThrow(draft.manifest_yaml);
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const siblings = await tx.agents.findMany({
        where: { organization_id: actor.organizationId, key: { startsWith: manifest.agent.key } },
        select: { key: true },
      });
      if (siblings.some((agent) => agent.key === manifest.agent.key)) {
        const base = manifest.agent.key.slice(0, 60);
        let suffix = 2;
        while (siblings.some((agent) => agent.key === `${base}-${suffix}`)) suffix += 1;
        manifest = { ...manifest, agent: { ...manifest.agent, key: `${base}-${suffix}` } };
      }
      const agent = await tx.agents.create({
        data: {
          organization_id: actor.organizationId,
          key: manifest.agent.key,
          name: manifest.agent.name,
          description: manifest.agent.description ?? null,
          project_brief: description,
          capability_resolution: draft.resolution as unknown as Prisma.InputJsonValue,
          latest_version: 1,
          created_by: actor.userId,
          versions: {
            create: {
              version: 1,
              status: "published",
              published_at: new Date(),
              manifest: manifest as unknown as Prisma.InputJsonValue,
              manifest_yaml: stringifyManifest(manifest),
              created_by: actor.userId,
            },
          },
          environment_configs: {
            create: [
              { stage: "staging", variables: {} },
              { stage: "production", variables: {} },
            ],
          },
        },
        include: { versions: true },
      });
      await recordAudit(
        tx,
        auditBy(actor, {
          action: "agent.project.create",
          targetType: "agent",
          targetId: agent.id,
          detail: { key: agent.key, selected_tools: draft.resolution.selected_tools },
        }),
      );
      return toAgentDto(agent, true);
    });
  }

  async getProject(actor: MemberActor, id: string): Promise<AgentProjectDto> {
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const agent = await tx.agents.findFirst({
        where: { id, organization_id: actor.organizationId },
        include: { versions: true },
      });
      if (!agent) throw notFound("エージェント");
      const [links, environments, builds, deployments, connectors] = await Promise.all([
        tx.agent_connection_links.findMany({
          where: { agent_id: id, organization_id: actor.organizationId },
          include: { connector: true, connection: true },
          orderBy: [{ stage: "asc" }, { created_at: "asc" }],
        }),
        tx.agent_environment_configs.findMany({ where: { agent_id: id, organization_id: actor.organizationId } }),
        tx.agent_builds.findMany({ where: { agent_id: id, organization_id: actor.organizationId }, orderBy: { build_number: "desc" } }),
        tx.deployments.findMany({
          where: { agent_id: id, organization_id: actor.organizationId },
          include: { agent: true, agent_version: true, runtime_profile: { include: { runtime: true } }, build: true, runs: { orderBy: { created_at: "desc" }, take: 20 } },
          orderBy: { created_at: "desc" },
        }),
        tx.connectors.findMany({ where: { organization_id: actor.organizationId }, select: { id: true, auth_type: true } }),
      ]);
      const dto = toAgentDto(agent, true);
      dto.capability_resolution = resolveProjectReadiness(dto.capability_resolution, links, environments, connectors, "staging");
      const preview = deployments.find((deployment) => deployment.stage === "staging" && deployment.status === "active");
      const base = this.deps.env.PUBLIC_BASE_URL.replace(/\/$/, "");
      const apiBase = this.deps.env.PUBLIC_API_BASE_URL.replace(/\/$/, "");
      return {
        agent: dto,
        connection_links: links.map(toAgentConnectionLinkDto),
        environments: environments.map(toAgentEnvironmentConfigDto),
        builds: builds.map(toAgentBuildDto),
        deployments: deployments.map((deployment) => {
          const dto = toDeploymentDto(deployment);
          dto.health_status = deploymentHealth(deployment, links);
          return dto;
        }),
        preview_url: preview ? `${base}/agents/${id}?tab=preview` : null,
        preview_api_url: preview ? `${apiBase}/api/v1/agents/${id}/invoke?stage=staging` : null,
      };
    });
  }

  async linkConnection(actor: MemberActor, agentId: string, input: LinkAgentConnectionInput): Promise<AgentProjectDto> {
    requireRole(actor, "builder");
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      const [agent, connector, connection] = await Promise.all([
        tx.agents.findFirst({ where: { id: agentId, organization_id: actor.organizationId } }),
        tx.connectors.findFirst({ where: { id: input.connector_id, organization_id: actor.organizationId }, include: { tools: true } }),
        tx.connections.findFirst({ where: { id: input.connection_id, organization_id: actor.organizationId } }),
      ]);
      if (!agent) throw notFound("エージェント");
      if (!connector || !connection || connection.connector_id !== connector.id) {
        throw validationError("この連携サービスで利用できる接続ではありません");
      }
      if (connection.status !== "connected" || (connector.auth_type !== "none" && !connection.secret_locator && connection.scope !== "runtime")) {
        throw preconditionFailed("接続の認証情報がまだ利用できません");
      }
      const available = new Set(connector.tools.map((tool) => tool.name));
      if (input.allowed_capabilities.some((name) => !available.has(name))) {
        throw validationError("許可対象に、この連携サービスにない操作が含まれています");
      }
      await tx.agent_connection_links.upsert({
        where: { agent_id_stage_connector_id: { agent_id: agentId, stage: input.stage, connector_id: connector.id } },
        create: {
          organization_id: actor.organizationId,
          agent_id: agentId,
          connector_id: connector.id,
          connection_id: connection.id,
          stage: input.stage,
          allowed_capabilities: input.allowed_capabilities,
          created_by: actor.userId,
        },
        update: { connection_id: connection.id, allowed_capabilities: input.allowed_capabilities },
      });
      await recordAudit(
        tx,
        auditBy(actor, {
          action: "agent.connection.link",
          targetType: "agent",
          targetId: agentId,
          detail: { connector_id: connector.id, connection_id: connection.id, stage: input.stage, capabilities: input.allowed_capabilities },
        }),
      );
    });
    return this.getProject(actor, agentId);
  }

  async setEnvironment(actor: MemberActor, agentId: string, input: SetAgentEnvironmentInput): Promise<AgentProjectDto> {
    requireRole(actor, "builder");
    const secretLike = Object.keys(input.variables).find((key) => /(SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)/i.test(key));
    if (secretLike) throw validationError(`${secretLike} はVariablesではなく連携サービスの認証情報として設定してください`);
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      const agent = await tx.agents.findFirst({ where: { id: agentId, organization_id: actor.organizationId } });
      if (!agent) throw notFound("エージェント");
      await tx.agent_environment_configs.upsert({
        where: { agent_id_stage: { agent_id: agentId, stage: input.stage } },
        create: { organization_id: actor.organizationId, agent_id: agentId, stage: input.stage, variables: input.variables },
        update: { variables: input.variables },
      });
      await recordAudit(
        tx,
        auditBy(actor, {
          action: "agent.environment.update",
          targetType: "agent",
          targetId: agentId,
          detail: { stage: input.stage, variable_names: Object.keys(input.variables) },
        }),
      );
    });
    return this.getProject(actor, agentId);
  }

  /** 検証（エラーは保存を止める。警告は止めない） */
  async validate(actor: MemberActor, source: string): Promise<ManifestValidationDto> {
    const parsed = parseManifest(source);
    if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: [] };
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const { errors, warnings } = await this.checkReferences(tx, actor.organizationId, parsed.manifest);
      return { ok: errors.length === 0, errors: errors.map((message) => ({ path: "tools", message })), warnings };
    });
  }

  private async checkReferences(tx: Tx, organizationId: string, manifest: AgentManifest) {
    const { errors } = await resolveTools(tx, organizationId, manifest.tools);
    const warnings: string[] = [];
    if (manifest.environment.profile) {
      const profile = await tx.runtime_profiles.findUnique({
        where: { organization_id_key: { organization_id: organizationId, key: manifest.environment.profile } },
      });
      if (!profile) warnings.push(`実行環境 ${manifest.environment.profile} はまだありません（デプロイ時に選べます）`);
    }
    if (!manifest.model.name && !this.deps.env.OPENAI_DEFAULT_MODEL) {
      warnings.push("model.name が未指定で、既定のモデルも設定されていません");
    }
    return { errors, warnings };
  }

  async create(actor: MemberActor, source: string): Promise<AgentDto> {
    requireRole(actor, "builder");
    const manifest = this.parseOrThrow(source);
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const { errors } = await this.checkReferences(tx, actor.organizationId, manifest);
      if (errors.length > 0) throw validationError(errors[0]!, { errors });
      const dup = await tx.agents.findUnique({ where: { organization_id_key: { organization_id: actor.organizationId, key: manifest.agent.key } } });
      if (dup) throw conflict(`キー ${manifest.agent.key} のエージェントはすでにあります`);
      const agent = await tx.agents.create({
        data: {
          organization_id: actor.organizationId,
          key: manifest.agent.key,
          name: manifest.agent.name,
          description: manifest.agent.description ?? null,
          latest_version: 1,
          created_by: actor.userId,
          versions: {
            create: {
              version: 1,
              manifest: manifest as unknown as Prisma.InputJsonValue,
              manifest_yaml: stringifyManifest(manifest),
              created_by: actor.userId,
            },
          },
        },
        include: { versions: true },
      });
      await recordAudit(tx, auditBy(actor, { action: "agent.create", targetType: "agent", targetId: agent.id, detail: { key: agent.key } }));
      return toAgentDto(agent, true);
    });
  }

  async createVersion(actor: MemberActor, id: string, source: string): Promise<AgentVersionDto> {
    requireRole(actor, "builder");
    const manifest = this.parseOrThrow(source);
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const agent = await tx.agents.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!agent) throw notFound("エージェント");
      if (manifest.agent.key !== agent.key) throw validationError("agent.key は変更できません");
      const { errors } = await this.checkReferences(tx, actor.organizationId, manifest);
      if (errors.length > 0) throw validationError(errors[0]!, { errors });
      const version = agent.latest_version + 1;
      const v = await tx.agent_versions.create({
        data: {
          organization_id: actor.organizationId,
          agent_id: id,
          version,
          manifest: manifest as unknown as Prisma.InputJsonValue,
          manifest_yaml: stringifyManifest(manifest),
          created_by: actor.userId,
        },
      });
      await tx.agents.update({
        where: { id },
        data: { latest_version: version, name: manifest.agent.name, description: manifest.agent.description ?? null },
      });
      await recordAudit(tx, auditBy(actor, { action: "agent.version.create", targetType: "agent", targetId: id, detail: { version } }));
      return toAgentVersionDto(v);
    });
  }

  /** 公開する。公開したバージョンは変更できない（AGT-02） */
  async publish(actor: MemberActor, id: string, version: number): Promise<AgentVersionDto> {
    requireRole(actor, "builder");
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const v = await tx.agent_versions.findFirst({ where: { agent_id: id, version, organization_id: actor.organizationId } });
      if (!v) throw notFound("バージョン");
      if (v.status !== "draft") throw preconditionFailed("下書きのバージョンだけ公開できます");
      const updated = await tx.agent_versions.update({ where: { id: v.id }, data: { status: "published", published_at: new Date() } });
      await recordAudit(tx, auditBy(actor, { action: "agent.version.publish", targetType: "agent", targetId: id, detail: { version } }));
      return toAgentVersionDto(updated);
    });
  }

  /** 日本語の説明から Manifest の案を作る（AGT-03）。保存はしない */
  async generate(actor: MemberActor, description: string): Promise<GenerateManifestResultDto> {
    requireRole(actor, "builder");
    const { tools, profiles, connections } = await this.deps.db.run(scopeOf(actor), async (tx) => {
      const tools = await tx.tools.findMany({
        where: { organization_id: actor.organizationId },
        include: { versions: true, connector: true },
      });
      const profiles = await tx.runtime_profiles.findMany({ where: { organization_id: actor.organizationId } });
      const connections = await tx.connections.findMany({
        where: { organization_id: actor.organizationId, status: "connected", connector_id: { not: null } },
        select: { connector_id: true },
      });
      return { tools, profiles, connections };
    });

    const toolInfos = tools.map((t) => {
      const latest = t.versions.find((v) => v.version === t.latest_version);
      const spec = latest?.spec as unknown as ToolVersionSpec | undefined;
      const schema = spec && "input_schema" in spec ? spec.input_schema : undefined;
      return {
        name: t.name,
        display_name: t.display_name,
        description: spec?.description ?? "",
        execution_location: t.execution_location,
        risk: t.risk,
        input_fields: Object.keys(schema?.properties ?? {}),
        connector_id: t.connector_id,
        connector_name: t.connector?.name ?? null,
        connector_auth_type: t.connector?.auth_type ?? null,
      };
    });
    const generated = await this.deps.generator.generate({
      organizationId: actor.organizationId,
      description,
      tools: toolInfos,
      profiles: profiles.map((p) => ({ key: p.key, name: p.name, type: p.type })),
    });
    const resolution = resolveCapabilities(
      generated,
      toolInfos,
      new Set(connections.flatMap((connection) => (connection.connector_id ? [connection.connector_id] : []))),
    );
    const selectedLocations = new Set(
      resolution.selected_tools.flatMap((name) => {
        const selected = tools.find((tool) => tool.name === name);
        return selected ? [selected.execution_location] : [];
      }),
    );
    const requiredProfileType = selectedLocations.has("runtime_mcp") ? "self_hosted" : undefined;
    const chosenProfile = requiredProfileType ? profiles.find((profile) => profile.type === requiredProfileType) : undefined;
    return toManifestDraft(
      generated,
      new Set(tools.map((t) => t.name)),
      new Set(profiles.map((p) => p.key)),
      resolution,
      (chosenProfile ?? profiles.find((profile) => profile.type === "openai_hosted") ?? profiles[0])?.key,
    );
  }

  private parseOrThrow(source: string): AgentManifest {
    const parsed = parseManifest(source);
    if (!parsed.ok) throw validationError(`Manifest に誤りがあります: ${parsed.errors[0]?.message ?? ""}`, { errors: parsed.errors });
    return parsed.manifest;
  }

  // ---------------------------------------------------------------------------
  // Eval（EVAL）
  // ---------------------------------------------------------------------------
  async listEvalCases(actor: MemberActor, agentId: string): Promise<EvalCaseDto[]> {
    return this.deps.db.run(scopeOf(actor), async (tx) =>
      (await tx.eval_cases.findMany({ where: { organization_id: actor.organizationId, agent_id: agentId }, orderBy: { created_at: "asc" } })).map(toEvalCaseDto),
    );
  }

  async createEvalCase(actor: MemberActor, agentId: string, raw: CreateEvalCaseInput): Promise<EvalCaseDto> {
    requireRole(actor, "builder");
    const input = createEvalCaseSchema.parse(raw);
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const agent = await tx.agents.findFirst({ where: { id: agentId, organization_id: actor.organizationId } });
      if (!agent) throw notFound("エージェント");
      const c = await tx.eval_cases.create({
        data: {
          organization_id: actor.organizationId,
          agent_id: agentId,
          name: input.name,
          input: input.input,
          expectations: input.expectations as Prisma.InputJsonValue,
        },
      });
      return toEvalCaseDto(c);
    });
  }

  async deleteEvalCase(actor: MemberActor, id: string): Promise<void> {
    requireRole(actor, "builder");
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      const c = await tx.eval_cases.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!c) throw notFound("テストケース");
      await tx.eval_cases.delete({ where: { id } });
    });
  }

  async listEvalRuns(actor: MemberActor, agentId: string): Promise<EvalRunDto[]> {
    return this.deps.db.run(scopeOf(actor), async (tx) =>
      (await tx.eval_runs.findMany({ where: { organization_id: actor.organizationId, agent_id: agentId }, orderBy: { created_at: "desc" }, take: 50 })).map(toEvalRunDto),
    );
  }

  /** デプロイに対して、Agent の全テストケースを実行する（EVAL-02）。判定は Worker が行う */
  async startEvalRun(actor: MemberActor, agentId: string, deploymentId: string): Promise<EvalRunDto> {
    requireRole(actor, "builder");
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const deployment = await tx.deployments.findFirst({
        where: { id: deploymentId, organization_id: actor.organizationId, agent_id: agentId, status: "active" },
      });
      if (!deployment) throw notFound("有効なデプロイ");
      const cases = await tx.eval_cases.findMany({ where: { organization_id: actor.organizationId, agent_id: agentId } });
      if (cases.length === 0) throw preconditionFailed("テストケースがありません");

      const evalRun = await tx.eval_runs.create({
        data: { organization_id: actor.organizationId, agent_id: agentId, deployment_id: deploymentId, requested_by: actor.userId },
      });
      const results = [];
      for (const c of cases) {
        const run = await createRunInTx(tx, actor.organizationId, deploymentId, c.input, actor.userId, { eval_run_id: evalRun.id });
        results.push({ case_id: c.id, case_name: c.name, run_id: run.id, status: "pending", reasons: [] });
      }
      const updated = await tx.eval_runs.update({ where: { id: evalRun.id }, data: { results: results as Prisma.InputJsonValue } });
      await recordAudit(tx, auditBy(actor, { action: "eval.start", targetType: "agent", targetId: agentId, detail: { eval_run_id: evalRun.id, cases: cases.length } }));
      return toEvalRunDto(updated);
    });
  }
}

/**
 * 生成結果を Manifest の YAML にする。
 * 使う能力・実行環境・risk による承認はコード側で決め、モデルには書かせない。
 */
export function toManifestDraft(
  g: GeneratedAgent,
  toolNames: Set<string>,
  profileKeys: Set<string>,
  resolution?: CapabilityResolutionDto,
  /** runtime_mcp を含むなら self_hosted になる。呼び出し側が算出して渡す */
  environmentProfile?: string,
): GenerateManifestResultDto {
  const notes: string[] = [];
  const tools = [...new Set(resolution?.selected_tools ?? [])].filter((t) => {
    if (toolNames.has(t)) return true;
    notes.push(`ツール ${t} は登録されていないため外しました`);
    return false;
  });

  // しきい値つきの承認だけモデルが出す。それ以外の承認は Build 時に risk から付く
  const policies: Policy[] = [];
  for (const r of g.conditional_approvals ?? []) {
    if (!tools.includes(r.tool)) continue;
    const when = { field: r.field, op: r.op, value: r.value, ...(r.abs ? { abs: true } : {}) };
    const parsed = policySchema.safeParse({ type: "approval", tool: r.tool, when, reason: r.reason });
    if (parsed.success) policies.push(parsed.data);
  }

  const key = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(g.key) && g.key.length >= 2 ? g.key.slice(0, 63) : "new-agent";
  const profile = environmentProfile && profileKeys.has(environmentProfile) ? environmentProfile : undefined;

  const manifest: AgentManifest = {
    schema_version: 1,
    agent: { key, name: g.name.slice(0, 100) || "新しいエージェント", ...(g.description ? { description: g.description.slice(0, 2000) } : {}) },
    model: {},
    instructions: g.instructions,
    tools,
    policies,
    environment: profile ? { profile } : {},
  };
  const check = parseManifest(manifest);
  if (!check.ok) notes.push(`生成した定義に確認が必要な点があります: ${check.errors.map((e) => e.message).join(" / ")}`);
  const fallbackResolution: CapabilityResolutionDto = resolution ?? {
    requirements: tools.map((tool) => ({
      requirement: tool,
      state: "resolved",
      connector_id: null,
      connector_name: null,
      tool_names: [tool],
      confidence: 1,
      reason: "生成結果で選択されました",
      variables: [],
    })),
    selected_tools: tools,
    missing_variables: [],
    ready: true,
  };
  return { manifest_yaml: stringifyManifest(manifest), notes, resolution: fallbackResolution };
}

function deploymentHealth(
  deployment: {
    stage: string;
    health_status: string;
    runtime_profile: { runtime?: { status: string } | null };
    runs: { status: string; outcome: string }[];
  },
  links: { stage: string; connection: { status: string } }[],
): "ready" | "degraded" | "failed" {
  const runtimeStatus = deployment.runtime_profile.runtime?.status;
  if (runtimeStatus === "offline" || runtimeStatus === "revoked") return "failed";
  if (runtimeStatus && runtimeStatus !== "active") return "degraded";
  if (links.some((link) => link.stage === deployment.stage && link.connection.status !== "connected")) return "degraded";
  const finished = deployment.runs.filter((run) => ["completed", "failed", "cancelled"].includes(run.status));
  const failed = finished.filter((run) => run.status === "failed" || run.outcome === "completed_with_errors").length;
  if (finished.length >= 3 && failed / finished.length >= 0.8) return "failed";
  if (finished.length >= 3 && failed / finished.length >= 0.3) return "degraded";
  return deployment.health_status === "failed" ? "failed" : "ready";
}

function resolveProjectReadiness(
  resolution: CapabilityResolutionDto,
  links: { stage: string; connector_id: string; allowed_capabilities: unknown }[],
  environments: { stage: string; variables: unknown }[],
  connectors: { id: string; auth_type: string }[],
  stage: "staging" | "production",
): CapabilityResolutionDto {
  const stageLinks = links.filter((link) => link.stage === stage);
  const requirements = resolution.requirements.map((requirement) => {
    if (!requirement.connector_id || requirement.state === "missing" || requirement.state === "ambiguous") return requirement;
    if (connectors.find((connector) => connector.id === requirement.connector_id)?.auth_type === "none") {
      return { ...requirement, state: "resolved" as const };
    }
    const linked = stageLinks.find((link) => link.connector_id === requirement.connector_id);
    const allowed = new Set(Array.isArray(linked?.allowed_capabilities) ? (linked.allowed_capabilities as string[]) : []);
    const ready = Boolean(linked) && requirement.tool_names.every((tool) => allowed.has(tool));
    return { ...requirement, state: ready ? ("resolved" as const) : ("needs_connection" as const) };
  });
  const values = (environments.find((environment) => environment.stage === stage)?.variables ?? {}) as Record<string, string>;
  const missingVariables = resolution.missing_variables.filter((name) => !values[name]);
  return {
    ...resolution,
    requirements,
    missing_variables: missingVariables,
    ready: requirements.every((requirement) => requirement.state === "resolved") && missingVariables.length === 0,
  };
}
