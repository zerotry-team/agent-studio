import type { Prisma } from "@prisma/client";
import {
  createEvalCaseSchema,
  parseManifest,
  parseToolRef,
  policySchema,
  stringifyManifest,
  type AgentDto,
  type AgentManifest,
  type AgentVersionDto,
  type CreateEvalCaseInput,
  type EvalCaseDto,
  type EvalRunDto,
  type GenerateManifestResultDto,
  type ManifestValidationDto,
  type Policy,
  type ToolVersionSpec,
} from "@agent-studio/contracts";
import { conflict, notFound, preconditionFailed, validationError } from "../domain/errors.js";
import type { ResolvedTool } from "../domain/manifest-compiler.js";
import { recordAudit } from "../infrastructure/audit.js";
import type { Tx } from "../infrastructure/db/tenant-db.js";
import type { GeneratedAgent } from "../infrastructure/llm/manifest-generator.js";
import { auditBy, requireRole, scopeOf, type MemberActor } from "./context.js";
import type { Deps } from "./deps.js";
import { toAgentDto, toAgentVersionDto, toEvalCaseDto, toEvalRunDto } from "./dto.js";
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
    tools.push({ tool_id: tool.id, tool_version_id: v.id, name, version: v.version, spec: v.spec as unknown as ToolVersionSpec });
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

  async get(actor: MemberActor, id: string): Promise<AgentDto> {
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const agent = await tx.agents.findFirst({ where: { id, organization_id: actor.organizationId }, include: { versions: true } });
      if (!agent) throw notFound("エージェント");
      return toAgentDto(agent, true);
    });
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
    const { tools, profiles } = await this.deps.db.run(scopeOf(actor), async (tx) => {
      const tools = await tx.tools.findMany({ where: { organization_id: actor.organizationId }, include: { versions: true } });
      const profiles = await tx.runtime_profiles.findMany({ where: { organization_id: actor.organizationId } });
      return { tools, profiles };
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
      };
    });
    const generated = await this.deps.generator.generate({
      description,
      tools: toolInfos,
      profiles: profiles.map((p) => ({ key: p.key, name: p.name, type: p.type })),
    });
    return toManifestDraft(generated, new Set(tools.map((t) => t.name)), new Set(profiles.map((p) => p.key)));
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

/** 生成結果を Manifest の YAML にする。存在しないツール・実行環境は外して notes で伝える */
export function toManifestDraft(g: GeneratedAgent, toolNames: Set<string>, profileKeys: Set<string>): GenerateManifestResultDto {
  const notes = [...g.notes];
  const tools = [...new Set(g.tools)].filter((t) => {
    if (toolNames.has(t)) return true;
    notes.push(`ツール ${t} は登録されていないため外しました`);
    return false;
  });

  const policies: Policy[] = [];
  for (const r of g.approval_rules) {
    if (!tools.includes(r.tool)) continue;
    const when = r.field && r.op && r.value !== null ? { field: r.field, op: r.op, value: r.value, ...(r.abs ? { abs: true } : {}) } : undefined;
    const parsed = policySchema.safeParse({ type: "approval", tool: r.tool, ...(when ? { when } : {}), reason: r.reason });
    if (parsed.success) policies.push(parsed.data);
  }

  const key = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(g.key) && g.key.length >= 2 ? g.key.slice(0, 63) : "new-agent";
  const profile = g.environment_profile && profileKeys.has(g.environment_profile) ? g.environment_profile : undefined;

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
  return { manifest_yaml: stringifyManifest(manifest), notes };
}
