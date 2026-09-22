import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  canonicalJson,
  createRuntimeProfileSchema,
  createManagedRuntimeEnvironmentSchema,
  isBrowserAccessConfigured,
  usesBrowserCapability,
  type AgentManifest,
  parseToolRef,
  type BootstrapTokenDto,
  type CapabilityResolutionDto,
  type CreateDeploymentInput,
  type CreateRuntimeInput,
  type CreateRuntimeProfileInput,
  type CreateManagedRuntimeEnvironmentInput,
  type ManagedRuntimeEnvironmentDto,
  type DeploymentDto,
  type EnvironmentPlanDto,
  type NetworkPolicy,
  type OpenAiTemplate,
  type Policy,
  type RuntimeDto,
  type RuntimeProfileDto,
  type RuntimeToolCatalogEntry,
} from "@agent-studio/contracts";
import { conflict, notFound, preconditionFailed, validationError } from "../domain/errors.js";
import { compileAgent, type CompileProfile } from "../domain/manifest-compiler.js";
import { recordAudit } from "../infrastructure/audit.js";
import { auditBy, requireRole, scopeOf, type MemberActor } from "./context.js";
import type { Deps } from "./deps.js";
import { toDeploymentDto, toRuntimeDto, toRuntimeProfileDto } from "./dto.js";
import { resolveTools } from "./agents.js";

const BOOTSTRAP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export class EnvironmentService {
  constructor(private readonly deps: Deps) {}

  // ---------------------------------------------------------------------------
  // 実行環境の設定（ENV）
  // ---------------------------------------------------------------------------
  async listProfiles(actor: MemberActor): Promise<RuntimeProfileDto[]> {
    return this.deps.db.run(scopeOf(actor), async (tx) =>
      (
        await tx.runtime_profiles.findMany({
          where: { organization_id: actor.organizationId },
          include: { runtime: true },
          orderBy: { created_at: "asc" },
        })
      ).map(toRuntimeProfileDto),
    );
  }

  async createProfile(actor: MemberActor, raw: CreateRuntimeProfileInput): Promise<RuntimeProfileDto> {
    requireRole(actor, "admin");
    const input = createRuntimeProfileSchema.parse(raw);
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const dup = await tx.runtime_profiles.findUnique({ where: { organization_id_key: { organization_id: actor.organizationId, key: input.key } } });
      if (dup) throw conflict(`キー ${input.key} の実行環境はすでにあります`);
      if (input.type === "self_hosted") {
        const runtime = await tx.runtimes.findFirst({ where: { id: input.runtime_id, organization_id: actor.organizationId } });
        if (!runtime) throw validationError("指定した Runtime が見つかりません");
        if (runtime.status === "revoked") throw preconditionFailed("無効にされた Runtime は使えません");
      }
      const profile = await tx.runtime_profiles.create({
        data: {
          organization_id: actor.organizationId,
          key: input.key,
          name: input.name,
          type: input.type,
          template: input.type === "openai_hosted" ? input.template : null,
          network: input.type === "openai_hosted" ? (input.network as Prisma.InputJsonValue) : undefined,
          runtime_id: input.type === "self_hosted" ? input.runtime_id : null,
        },
        include: { runtime: true },
      });
      await recordAudit(tx, auditBy(actor, { action: "environment.create", targetType: "runtime_profile", targetId: profile.id, detail: { key: input.key, type: input.type } }));
      return toRuntimeProfileDto(profile);
    });
  }

  /**
   * Builder が決めた構成に合う実行環境を用意する。利用者に名前・キー・テンプレートを入力させない。
   * 既存の openai_hosted で同じ構成があれば再利用し、無ければ Builder 名義で作る（管理者ロール不要）。
   */
  async ensureBuilderProfile(actor: MemberActor, plan: EnvironmentPlanDto): Promise<RuntimeProfileDto> {
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      if (plan.kind === "self_hosted") {
        const profile = await tx.runtime_profiles.findFirst({
          where: { organization_id: actor.organizationId, type: "self_hosted", runtime: { status: { in: ["active", "degraded"] } } },
          include: { runtime: true },
          orderBy: { created_at: "asc" },
        });
        if (!profile) throw preconditionFailed("貴社専用の実行環境がまだ準備できていません。AWS管理者の承認後に自動で再開します");
        return toRuntimeProfileDto(profile);
      }
      const candidates = await tx.runtime_profiles.findMany({
        where: { organization_id: actor.organizationId, type: "openai_hosted", template: plan.template },
        include: { runtime: true },
        orderBy: { created_at: "asc" },
      });
      const sameNetwork = candidates.find((profile) => canonicalJson(profile.network ?? { mode: "disabled" }) === canonicalJson(plan.network ?? { mode: "disabled" }));
      if (sameNetwork) return toRuntimeProfileDto(sameNetwork);
      const byKey = await tx.runtime_profiles.findUnique({ where: { organization_id_key: { organization_id: actor.organizationId, key: plan.profile_key } }, include: { runtime: true } });
      if (byKey) return toRuntimeProfileDto(byKey);
      const profile = await tx.runtime_profiles.create({
        data: {
          organization_id: actor.organizationId,
          key: plan.profile_key,
          name: plan.profile_name,
          type: "openai_hosted",
          template: plan.template,
          network: (plan.network ?? { mode: "disabled" }) as Prisma.InputJsonValue,
        },
        include: { runtime: true },
      });
      await recordAudit(tx, auditBy(actor, { action: "environment.create", targetType: "runtime_profile", targetId: profile.id, detail: { key: profile.key, type: "openai_hosted", managed_by: "builder", reason: plan.reason } }));
      return toRuntimeProfileDto(profile);
    });
  }

  async deleteProfile(actor: MemberActor, id: string): Promise<void> {
    requireRole(actor, "admin");
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      const profile = await tx.runtime_profiles.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!profile) throw notFound("実行環境");
      const used = await tx.deployments.count({ where: { runtime_profile_id: id, organization_id: actor.organizationId } });
      if (used > 0) throw conflict("この実行環境を使うデプロイがあるため削除できません");
      await tx.runtime_profiles.delete({ where: { id } });
      await recordAudit(tx, auditBy(actor, { action: "environment.delete", targetType: "runtime_profile", targetId: id, detail: { key: profile.key } }));
    });
  }

  // ---------------------------------------------------------------------------
  // Runtime（RTM）
  // ---------------------------------------------------------------------------
  async listRuntimes(actor: MemberActor): Promise<RuntimeDto[]> {
    return this.deps.db.run(scopeOf(actor), async (tx) =>
      (await tx.runtimes.findMany({ where: { organization_id: actor.organizationId }, orderBy: { created_at: "asc" } })).map(toRuntimeDto),
    );
  }

  async getRuntime(actor: MemberActor, id: string): Promise<RuntimeDto> {
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const r = await tx.runtimes.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!r) throw notFound("Runtime");
      return toRuntimeDto(r);
    });
  }

  /** Runtime を作る（RTM-01）。AWS アカウント ID とロール名は、登録時の身元確認に使う */
  async createRuntime(actor: MemberActor, input: CreateRuntimeInput): Promise<RuntimeDto> {
    requireRole(actor, "admin");
    return this.deps.db.run(scopeOf(actor), (tx) => this.createRuntimeIn(tx, actor, input));
  }

  /** Builder の Human Action からも同じ手順で Runtime を作る（ロール検査は呼び出し側）。 */
  async createRuntimeIn(tx: Prisma.TransactionClient, actor: MemberActor, input: CreateRuntimeInput): Promise<RuntimeDto> {
    requireRole(actor, "admin");
    {
      // 同じ AWS プリンシパルは全組織を通じて1つの Runtime にしか使えない
      const duplicate = await tx.runtimes.findUnique({ where: { aws_account_id_expected_role_name: { aws_account_id: input.aws_account_id, expected_role_name: input.expected_role_name } } });
      if (duplicate) {
        if (duplicate.organization_id === actor.organizationId) return toRuntimeDto(duplicate);
        throw conflict("このAWSアカウントとロール名の組み合わせは、すでに別の環境で使われています");
      }
      const r = await tx.runtimes.create({
        data: {
          organization_id: actor.organizationId,
          name: input.name,
          stage: input.stage,
          provisioning_type: input.provisioning_type,
          aws_account_id: input.aws_account_id,
          aws_region: input.aws_region,
          expected_role_name: input.expected_role_name,
        },
      });
      await recordAudit(
        tx,
        auditBy(actor, {
          action: "runtime.create",
          targetType: "runtime",
          targetId: r.id,
          detail: { aws_account_id: input.aws_account_id, role: input.expected_role_name, stage: input.stage },
        }),
      );
      return toRuntimeDto(r);
    }
  }

  /** Builder が用意した Runtime に対応する self_hosted の実行環境（キー・名前は自動）。 */
  async ensureSelfHostedProfileIn(tx: Prisma.TransactionClient, actor: MemberActor, runtimeId: string): Promise<RuntimeProfileDto> {
    const existing = await tx.runtime_profiles.findFirst({ where: { organization_id: actor.organizationId, type: "self_hosted", runtime_id: runtimeId }, include: { runtime: true } });
    if (existing) return toRuntimeProfileDto(existing);
    const base = "builder-self-hosted";
    let key = base;
    for (let attempt = 2; await tx.runtime_profiles.findUnique({ where: { organization_id_key: { organization_id: actor.organizationId, key } } }); attempt += 1) key = `${base}-${attempt}`;
    const profile = await tx.runtime_profiles.create({
      data: { organization_id: actor.organizationId, key, name: "貴社専用の実行環境", type: "self_hosted", runtime_id: runtimeId },
      include: { runtime: true },
    });
    await recordAudit(tx, auditBy(actor, { action: "environment.create", targetType: "runtime_profile", targetId: profile.id, detail: { key, type: "self_hosted", managed_by: "builder" } }));
    return toRuntimeProfileDto(profile);
  }

  /**
   * Agent Studio 管理のAWS Runtimeを要求する。
   * AWSアカウント作成とTerraform applyはWorkerが非同期で進める。
   */
  async createManagedEnvironment(
    actor: MemberActor,
    raw: CreateManagedRuntimeEnvironmentInput,
  ): Promise<ManagedRuntimeEnvironmentDto> {
    requireRole(actor, "admin");
    if (!this.deps.env.MANAGED_RUNTIME_PROVISIONING_ROLE_ARN) {
      throw preconditionFailed("Agent Studio管理AWSの自動構築がまだ設定されていません");
    }
    const input = createManagedRuntimeEnvironmentSchema.parse(raw);
    const requestSuffix = randomUUID().replaceAll("-", "").slice(0, 10);

    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const organization = await tx.organizations.findUnique({ where: { id: actor.organizationId } });
      if (!organization) throw notFound("組織");
      const duplicate = await tx.runtime_profiles.findUnique({
        where: { organization_id_key: { organization_id: actor.organizationId, key: input.key } },
      });
      if (duplicate) throw conflict(`キー ${input.key} の実行環境はすでにあります`);
      const existing = await tx.runtimes.findFirst({
        where: {
          organization_id: actor.organizationId,
          provisioning_type: "studio_managed",
          stage: input.stage,
          status: { not: "revoked" },
        },
      });
      if (existing) throw conflict(`${input.stage}用のAgent Studio管理Runtimeはすでにあります`);

      const tenantShort = managedTenantShort(organization.slug);
      const stageShort = input.stage === "production" ? "prod" : "stg";
      const accountName = managedAccountName(organization.slug, input.stage, requestSuffix);
      const accountEmail = managedAccountEmail(
        organization.slug,
        input.stage,
        requestSuffix,
        this.deps.env.MANAGED_RUNTIME_ACCOUNT_EMAIL_DOMAIN,
      );
      const runtime = await tx.runtimes.create({
        data: {
          organization_id: actor.organizationId,
          name: input.runtime_name,
          stage: input.stage,
          provisioning_type: "studio_managed",
          aws_account_id: null,
          aws_region: input.aws_region,
          expected_role_name: `as-${tenantShort}-${stageShort}-runtime`,
          status: "provisioning",
          provisioning_status: "queued",
          provisioning_step: "専用AWSアカウントの作成を待っています",
          provisioning_progress: 5,
          provisioning_account_name: accountName,
          provisioning_account_email: accountEmail,
          provisioning_tenant_short: tenantShort,
        },
      });
      const profile = await tx.runtime_profiles.create({
        data: {
          organization_id: actor.organizationId,
          key: input.key,
          name: input.name,
          type: "self_hosted",
          runtime_id: runtime.id,
        },
        include: { runtime: true },
      });
      await recordAudit(tx, auditBy(actor, {
        action: "runtime.managed_provisioning.request",
        targetType: "runtime",
        targetId: runtime.id,
        detail: { stage: input.stage, region: input.aws_region, profile_key: input.key },
      }));
      return { profile: toRuntimeProfileDto(profile), runtime: toRuntimeDto(runtime) };
    });
  }

  async retryManagedProvisioning(actor: MemberActor, runtimeId: string): Promise<RuntimeDto> {
    requireRole(actor, "admin");
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const runtime = await tx.runtimes.findFirst({ where: { id: runtimeId, organization_id: actor.organizationId } });
      if (!runtime) throw notFound("Runtime");
      if (runtime.provisioning_type !== "studio_managed" || runtime.provisioning_status !== "failed") {
        throw preconditionFailed("失敗したAgent Studio管理Runtimeだけ再試行できます");
      }
      const nextStatus = runtime.aws_account_id ? "infrastructure_applying" : "queued";
      const updated = await tx.runtimes.update({
        where: { id: runtime.id },
        data: {
          status: "provisioning",
          provisioning_status: nextStatus,
          provisioning_step: runtime.aws_account_id ? "AWS基盤の再構築を待っています" : "専用AWSアカウントの再確認を待っています",
          provisioning_progress: runtime.aws_account_id ? 45 : 5,
          provisioning_error: null,
          provisioning_request_id: runtime.aws_account_id ? runtime.provisioning_request_id : null,
          provisioning_lease_owner: null,
          provisioning_lease_until: null,
          provisioning_attempts: { increment: 1 },
          provisioning_completed_at: null,
        },
      });
      await recordAudit(tx, auditBy(actor, {
        action: "runtime.managed_provisioning.retry",
        targetType: "runtime",
        targetId: runtime.id,
        detail: { resumed_from: nextStatus },
      }));
      return toRuntimeDto(updated);
    });
  }

  /** 一度だけ使える登録用トークン（RTM-02 / SEC-06）。平文はこの応答でしか返さない */
  async issueBootstrapToken(actor: MemberActor, runtimeId: string): Promise<BootstrapTokenDto> {
    requireRole(actor, "admin");
    const token = `asbt_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + BOOTSTRAP_TOKEN_TTL_MS);
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      const r = await tx.runtimes.findFirst({ where: { id: runtimeId, organization_id: actor.organizationId } });
      if (!r) throw notFound("Runtime");
      if (r.status === "revoked") throw preconditionFailed("無効にされた Runtime にはトークンを発行できません");
      await tx.runtime_bootstrap_tokens.create({
        data: { organization_id: actor.organizationId, runtime_id: runtimeId, token_hash: hashToken(token), expires_at: expiresAt, created_by: actor.userId },
      });
      await recordAudit(tx, auditBy(actor, { action: "runtime.bootstrap_token.issue", targetType: "runtime", targetId: runtimeId, detail: { expires_at: expiresAt.toISOString() } }));
    });
    return { token, expires_at: expiresAt.toISOString() };
  }

  /** Runtime を無効にする（RTM-07）。以後のトークン発行を拒否し、未処理のジョブを取り消す */
  async revokeRuntime(actor: MemberActor, runtimeId: string): Promise<RuntimeDto> {
    requireRole(actor, "owner");
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const r = await tx.runtimes.findFirst({ where: { id: runtimeId, organization_id: actor.organizationId } });
      if (!r) throw notFound("Runtime");
      const updated = await tx.runtimes.update({ where: { id: runtimeId }, data: { status: "revoked", revoked_at: new Date() } });
      await tx.runtime_jobs.updateMany({
        where: { runtime_id: runtimeId, organization_id: actor.organizationId, status: { in: ["pending", "leased"] } },
        data: { status: "cancelled", error: "Runtime が無効にされました" },
      });
      await tx.runtime_bootstrap_tokens.updateMany({
        where: { runtime_id: runtimeId, organization_id: actor.organizationId, consumed_at: null },
        data: { consumed_at: new Date() },
      });
      await recordAudit(tx, auditBy(actor, { action: "runtime.revoke", targetType: "runtime", targetId: runtimeId }));
      return toRuntimeDto(updated);
    });
  }

  async rotateEnvironmentKey(actor: MemberActor, runtimeId: string): Promise<void> {
    requireRole(actor, "admin");
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      const r = await tx.runtimes.findFirst({ where: { id: runtimeId, organization_id: actor.organizationId } });
      if (!r) throw notFound("Runtime");
      if (r.status === "revoked" || r.status === "pending" || r.status === "provisioning") throw preconditionFailed("登録済みの Runtime にだけ配布できます");
      await tx.runtime_jobs.create({
        data: {
          organization_id: actor.organizationId,
          runtime_id: runtimeId,
          type: "rotate_environment_key",
          payload: { type: "rotate_environment_key" },
        },
      });
      await recordAudit(tx, auditBy(actor, { action: "runtime.environment_key.rotate", targetType: "runtime", targetId: runtimeId }));
    });
  }

  // ---------------------------------------------------------------------------
  // デプロイ（DEP）
  // ---------------------------------------------------------------------------
  async listDeployments(actor: MemberActor, agentId?: string): Promise<DeploymentDto[]> {
    return this.deps.db.run(scopeOf(actor), async (tx) =>
      (
        await tx.deployments.findMany({
          where: { organization_id: actor.organizationId, ...(agentId ? { agent_id: agentId } : {}) },
          include: { agent: true, agent_version: true, runtime_profile: true, build: true },
          orderBy: { created_at: "desc" },
          take: 200,
        })
      ).map(toDeploymentDto),
    );
  }

  /** 依存関係を検証し、Immutable BuildとPreview Deploymentを作る（AV-040）。 */
  async createPreview(actor: MemberActor, agentId: string): Promise<DeploymentDto> {
    requireRole(actor, "builder");
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const agent = await tx.agents.findFirst({
        where: { id: agentId, organization_id: actor.organizationId },
        include: { versions: { orderBy: { version: "desc" } } },
      });
      if (!agent) throw notFound("エージェント");
      const version = agent.versions.find((candidate) => candidate.status === "published");
      if (!version) throw preconditionFailed("公開済みのAgent Versionがありません");
      const manifest = version.manifest as unknown as AgentManifest;
      const resolution = agent.capability_resolution as unknown as CapabilityResolutionDto;
      const browserDomains = Array.isArray(agent.browser_allowed_domains) ? (agent.browser_allowed_domains as string[]) : [];
      const browserAccess = agent.browser_access === "public" ? "public" : "restricted";
      if (usesBrowserCapability(resolution) && !isBrowserAccessConfigured(browserAccess, browserDomains)) {
        throw preconditionFailed("ブラウザで接続できる範囲を設定してください");
      }
      const profile = manifest.environment.profile
        ? await tx.runtime_profiles.findUnique({
            where: { organization_id_key: { organization_id: actor.organizationId, key: manifest.environment.profile } },
            include: { runtime: true },
          })
        : await tx.runtime_profiles.findFirst({
            where: { organization_id: actor.organizationId },
            include: { runtime: true },
            orderBy: [{ type: "asc" }, { created_at: "asc" }],
          });
      if (!profile) throw preconditionFailed("Previewを動かす環境がありません。SettingsでEnvironmentを設定してください");

      // 接続済みのConnectionがあれば、利用者に選ばせず自動でこのAgentへ割り当てる（未接続の連携は従来どおり使わない扱い）
      await this.autoLinkConnections(tx, actor, agentId, "staging", resolution);
      const { variables, allowedTools } = await this.assertProjectDependencies(tx, actor.organizationId, agentId, "staging", resolution);
      const { config, warnings } = await this.compile(tx, actor.organizationId, manifest, profile, allowedTools, {
        access: browserAccess,
        allowed_domains: browserDomains,
      });
      const latestBuild = await tx.agent_builds.findFirst({ where: { agent_id: agentId }, orderBy: { build_number: "desc" } });
      const build = await tx.agent_builds.create({
        data: {
          organization_id: actor.organizationId,
          agent_id: agentId,
          agent_version_id: version.id,
          runtime_profile_id: profile.id,
          build_number: (latestBuild?.build_number ?? 0) + 1,
          resolution: resolution as unknown as Prisma.InputJsonValue,
          compiled_config: config as unknown as Prisma.InputJsonValue,
          build_log: [
            { type: "success", message: `${manifest.tools.length}個の能力を固定しました` },
            { type: "success", message: "Preview Connectionと権限を検証しました" },
            { type: "success", message: `Environment: ${profile.name}` },
            ...warnings.map((message) => ({ type: "warning", message })),
          ] as Prisma.InputJsonValue,
          created_by: actor.userId,
        },
      });
      await tx.deployments.updateMany({
        where: { organization_id: actor.organizationId, agent_id: agentId, stage: "staging", status: "active" },
        data: { status: "superseded" },
      });
      const deployment = await tx.deployments.create({
        data: {
          organization_id: actor.organizationId,
          agent_id: agentId,
          agent_version_id: version.id,
          runtime_profile_id: profile.id,
          build_id: build.id,
          stage: "staging",
          compiled_config: { ...config, variables } as unknown as Prisma.InputJsonValue,
          created_by: actor.userId,
        },
        include: { agent: true, agent_version: true, runtime_profile: true, build: true },
      });
      await recordAudit(
        tx,
        auditBy(actor, {
          action: "deployment.preview.create",
          targetType: "deployment",
          targetId: deployment.id,
          detail: { agent_id: agentId, build_id: build.id, build_number: build.build_number, variable_names: Object.keys(variables) },
        }),
      );
      return toDeploymentDto(deployment);
    });
  }

  /** Previewで検証した同一BuildをProductionへ昇格する（再コンパイルしない）。 */
  async promote(actor: MemberActor, previewDeploymentId: string): Promise<DeploymentDto> {
    requireRole(actor, "admin");
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const preview = await tx.deployments.findFirst({
        where: { id: previewDeploymentId, organization_id: actor.organizationId, stage: "staging" },
        include: { build: true, agent: true, agent_version: true, runtime_profile: true },
      });
      if (!preview?.build) throw preconditionFailed("Buildを持つPreview DeploymentだけProductionへ公開できます");
      if (preview.health_status !== "ready") throw preconditionFailed("PreviewがReadyではないため公開できません");
      const { variables } = await this.assertProjectDependencies(
        tx,
        actor.organizationId,
        preview.agent_id,
        "production",
        preview.build.resolution as unknown as CapabilityResolutionDto,
      );
      await tx.deployments.updateMany({
        where: { organization_id: actor.organizationId, agent_id: preview.agent_id, stage: "production", status: "active" },
        data: { status: "superseded" },
      });
      const baseConfig = preview.build.compiled_config as Record<string, unknown>;
      const production = await tx.deployments.create({
        data: {
          organization_id: actor.organizationId,
          agent_id: preview.agent_id,
          agent_version_id: preview.agent_version_id,
          runtime_profile_id: preview.runtime_profile_id,
          build_id: preview.build_id,
          promoted_from_id: preview.id,
          stage: "production",
          compiled_config: { ...baseConfig, variables } as Prisma.InputJsonValue,
          created_by: actor.userId,
        },
        include: { agent: true, agent_version: true, runtime_profile: true, build: true },
      });
      await recordAudit(
        tx,
        auditBy(actor, {
          action: "deployment.promote",
          targetType: "deployment",
          targetId: production.id,
          detail: { preview_deployment_id: preview.id, build_id: preview.build.id, build_number: preview.build.build_number },
        }),
      );
      return toDeploymentDto(production);
    });
  }

  /** 過去の成功済みProduction Buildへ戻す。Tool versionとPolicyはBuildからそのまま復元する。 */
  async rollback(actor: MemberActor, targetDeploymentId: string): Promise<DeploymentDto> {
    requireRole(actor, "admin");
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const target = await tx.deployments.findFirst({
        where: { id: targetDeploymentId, organization_id: actor.organizationId, stage: "production", health_status: "ready" },
        include: { build: true, agent: true, agent_version: true, runtime_profile: true },
      });
      if (!target?.build) throw preconditionFailed("RollbackできるBuildがありません");
      const { variables } = await this.assertProjectDependencies(
        tx,
        actor.organizationId,
        target.agent_id,
        "production",
        target.build.resolution as unknown as CapabilityResolutionDto,
      );
      await tx.deployments.updateMany({
        where: { organization_id: actor.organizationId, agent_id: target.agent_id, stage: "production", status: "active" },
        data: { status: "superseded" },
      });
      const restored = await tx.deployments.create({
        data: {
          organization_id: actor.organizationId,
          agent_id: target.agent_id,
          agent_version_id: target.agent_version_id,
          runtime_profile_id: target.runtime_profile_id,
          build_id: target.build_id,
          promoted_from_id: target.id,
          stage: "production",
          compiled_config: { ...(target.build.compiled_config as Record<string, unknown>), variables } as Prisma.InputJsonValue,
          created_by: actor.userId,
        },
        include: { agent: true, agent_version: true, runtime_profile: true, build: true },
      });
      await recordAudit(
        tx,
        auditBy(actor, {
          action: "deployment.rollback",
          targetType: "deployment",
          targetId: restored.id,
          detail: { rollback_target_id: target.id, build_id: target.build.id, build_number: target.build.build_number },
        }),
      );
      return toDeploymentDto(restored);
    });
  }

  /**
   * Build の前提条件を確認し、この環境で実際に使える能力を返す。
   * 利用者が Connection で許可しなかった操作は、エラーにせず Build から外す（使わない、という選択）。
   */
  /** 認証が必要な連携サービスごとに、接続テスト済みの最新Connectionを自動で割り当てる。既に割り当て済みなら触らない。 */
  private async autoLinkConnections(
    tx: Prisma.TransactionClient,
    actor: MemberActor,
    agentId: string,
    stage: "staging" | "production",
    resolution: CapabilityResolutionDto,
  ): Promise<void> {
    const byConnector = new Map<string, Set<string>>();
    // 旧データでは requirements が欠けていることがある（空配列として扱う）
    for (const requirement of resolution.requirements ?? []) {
      if (!requirement.connector_id || requirement.state !== "resolved") continue;
      const set = byConnector.get(requirement.connector_id) ?? new Set<string>();
      for (const name of requirement.tool_names) set.add(name);
      byConnector.set(requirement.connector_id, set);
    }
    if (byConnector.size === 0) return;
    const connectors = await tx.connectors.findMany({ where: { organization_id: actor.organizationId, id: { in: [...byConnector.keys()] } }, include: { tools: { select: { name: true } } } });
    const links = await tx.agent_connection_links.findMany({ where: { organization_id: actor.organizationId, agent_id: agentId, stage }, select: { connector_id: true } });
    const linked = new Set(links.map((link) => link.connector_id));
    for (const connector of connectors) {
      if (connector.auth_type === "none" || linked.has(connector.id)) continue;
      const connection = await tx.connections.findFirst({
        where: { organization_id: actor.organizationId, connector_id: connector.id, status: "connected", revoked_at: null, ...(stage === "production" ? {} : {}) },
        orderBy: { last_validated_at: "desc" },
      });
      if (!connection || (connection.scope !== "runtime" && !connection.secret_locator)) continue;
      const available = new Set(connector.tools.map((tool) => tool.name));
      const capabilities = [...(byConnector.get(connector.id) ?? [])].filter((name) => available.has(name));
      if (!capabilities.length) continue;
      await tx.agent_connection_links.create({
        data: {
          organization_id: actor.organizationId,
          agent_id: agentId,
          connector_id: connector.id,
          connection_id: connection.id,
          stage,
          allowed_capabilities: capabilities,
          created_by: actor.userId,
        },
      });
      await recordAudit(tx, auditBy(actor, {
        action: "agent.connection.link",
        targetType: "agent",
        targetId: agentId,
        detail: { connector_id: connector.id, connection_id: connection.id, stage, capabilities, automatic: true },
      }));
    }
  }

  private async assertProjectDependencies(
    tx: Prisma.TransactionClient,
    organizationId: string,
    agentId: string,
    stage: "staging" | "production",
    resolution: CapabilityResolutionDto,
  ): Promise<{ variables: Record<string, string>; allowedTools: Set<string> }> {
    // Capability Resolutionの配列が追加される前に保存されたAgentもPreviewできるようにする。
    // APIのDTOでは既に正規化しているが、Build作成はDBのJSONを直接読むため同じ境界が必要。
    const requirements = Array.isArray(resolution?.requirements) ? resolution.requirements : [];
    const missingVariables = Array.isArray(resolution?.missing_variables) ? resolution.missing_variables : [];
    const unresolved = requirements.find((requirement) => requirement.state === "missing" || requirement.state === "ambiguous");
    if (unresolved) throw preconditionFailed(`必要な能力「${unresolved.requirement}」を解決できていません`);

    const connectorIds = [...new Set(requirements.flatMap((requirement) => (requirement.connector_id ? [requirement.connector_id] : [])))];
    const connectors = await tx.connectors.findMany({ where: { organization_id: organizationId, id: { in: connectorIds } } });
    const links = await tx.agent_connection_links.findMany({
      where: { organization_id: organizationId, agent_id: agentId, stage, connector_id: { in: connectorIds } },
      include: { connection: true },
    });
    const environment = await tx.agent_environment_configs.findUnique({ where: { agent_id_stage: { agent_id: agentId, stage } } });

    const allowedTools = new Set<string>();
    let hasConnectorRequirement = false;
    for (const requirement of requirements) {
      const toolNames = Array.isArray(requirement.tool_names) ? requirement.tool_names : [];
      if (!requirement.connector_id) {
        for (const tool of toolNames) allowedTools.add(tool);
        continue;
      }
      hasConnectorRequirement = true;
      const connector = connectors.find((candidate) => candidate.id === requirement.connector_id);
      if (!connector) throw preconditionFailed(`連携サービス「${requirement.connector_name ?? requirement.requirement}」が見つかりません`);
      if (connector.auth_type === "none") {
        for (const tool of toolNames) allowedTools.add(tool);
        continue;
      }
      const link = links.find((candidate) => candidate.connector_id === connector.id);
      // 接続を設定していない連携サービスは、この環境では使わないものとして扱う
      if (!link) continue;
      if (link.connection.status !== "connected") throw preconditionFailed(`${connector.name} Connectionは${link.connection.status}です`);
      if (link.connection.scope !== "runtime" && !link.connection.secret_locator) {
        throw preconditionFailed(`${connector.name} Connectionの認証情報が未設定です`);
      }
      const allowed = new Set(link.allowed_capabilities as string[]);
      for (const tool of toolNames) if (allowed.has(tool)) allowedTools.add(tool);
    }
    if (hasConnectorRequirement && allowedTools.size === 0) {
      throw preconditionFailed("このAgentで使う作業を1つ以上選んでください");
    }

    const variables = (environment?.variables ?? {}) as Record<string, string>;
    const missingVariable = missingVariables.find((name) => !variables[name]);
    if (missingVariable) throw preconditionFailed(`Variable ${missingVariable} を設定してください`);
    return { variables, allowedTools };
  }

  private async compile(
    tx: Prisma.TransactionClient,
    organizationId: string,
    manifest: AgentManifest,
    profile: {
      id: string;
      key: string;
      type: string;
      template: string | null;
      network: Prisma.JsonValue | null;
      runtime: {
        id: string;
        status: string;
        gateway_url: string | null;
        tool_catalog: Prisma.JsonValue;
      } | null;
    },
    allowedTools: Set<string>,
    browserAccess?: { access: "restricted" | "public"; allowed_domains: string[] },
  ) {
    // 利用者が許可した能力だけを Build に含める
    const selected = manifest.tools.filter((ref) => allowedTools.has(parseToolRef(ref).name));
    const { tools, errors: toolErrors } = await resolveTools(tx, organizationId, selected);
    if (toolErrors.length > 0) throw preconditionFailed(toolErrors[0]!, { errors: toolErrors });
    const orgPolicies = (await tx.policies.findMany({ where: { organization_id: organizationId, enabled: true } })).map(
      (policy) => policy.rule as unknown as Policy,
    );
    const compileProfile: CompileProfile = {
      id: profile.id,
      key: profile.key,
      type: profile.type as CompileProfile["type"],
      template: (profile.template as OpenAiTemplate | null) ?? null,
      network: (profile.network as unknown as NetworkPolicy | null) ?? null,
      runtime: profile.runtime
        ? {
            id: profile.runtime.id,
            status: profile.runtime.status,
            gateway_url: profile.runtime.gateway_url,
            tool_catalog: profile.runtime.tool_catalog as unknown as RuntimeToolCatalogEntry[],
          }
        : null,
    };
    const result = compileAgent({ manifest, tools, profile: compileProfile, orgPolicies, defaultModel: this.deps.env.OPENAI_DEFAULT_MODEL });
    if (!result.ok) throw preconditionFailed(result.errors[0]!, { errors: result.errors, warnings: result.warnings });
    // ブラウザの接続範囲は Build に固定する（公開済みの Agent は作成時の範囲のまま動く）
    return { config: { ...result.config, ...(browserAccess ? { browser_access: browserAccess } : {}) }, warnings: result.config.warnings };
  }

  /**
   * デプロイする（DEP-01）。この時点で Manifest をコンパイルし、結果を保存する（CMP-04）。
   * ツールが実行環境で使えるか、Runtime が登録済みかをここで検証する（DEP-02）。
   */
  async createDeployment(actor: MemberActor, input: CreateDeploymentInput): Promise<DeploymentDto> {
    requireRole(actor, input.stage === "production" ? "admin" : "builder");
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const version = await tx.agent_versions.findFirst({
        where: { id: input.agent_version_id, organization_id: actor.organizationId },
      });
      if (!version) throw notFound("エージェントのバージョン");
      if (version.status !== "published") throw preconditionFailed("公開したバージョンだけデプロイできます");

      const profile = await tx.runtime_profiles.findFirst({
        where: { id: input.runtime_profile_id, organization_id: actor.organizationId },
        include: { runtime: true },
      });
      if (!profile) throw notFound("実行環境");
      if (profile.runtime && profile.runtime.stage !== input.stage) {
        throw preconditionFailed(`この実行環境の Runtime は ${profile.runtime.stage} 用です`);
      }

      const manifest = version.manifest as unknown as AgentManifest;
      const { tools, errors: toolErrors } = await resolveTools(tx, actor.organizationId, manifest.tools);
      if (toolErrors.length > 0) throw preconditionFailed(toolErrors[0]!, { errors: toolErrors });

      const orgPolicies = (
        await tx.policies.findMany({ where: { organization_id: actor.organizationId, enabled: true } })
      ).map((p) => p.rule as unknown as Policy);

      const compileProfile: CompileProfile = {
        id: profile.id,
        key: profile.key,
        type: profile.type as CompileProfile["type"],
        template: (profile.template as OpenAiTemplate | null) ?? null,
        network: (profile.network as unknown as NetworkPolicy | null) ?? null,
        runtime: profile.runtime
          ? {
              id: profile.runtime.id,
              status: profile.runtime.status,
              gateway_url: profile.runtime.gateway_url,
              tool_catalog: profile.runtime.tool_catalog as unknown as RuntimeToolCatalogEntry[],
            }
          : null,
      };
      const result = compileAgent({ manifest, tools, profile: compileProfile, orgPolicies, defaultModel: this.deps.env.OPENAI_DEFAULT_MODEL });
      if (!result.ok) throw preconditionFailed(result.errors[0]!, { errors: result.errors, warnings: result.warnings });

      // 同じ Agent・ステージの有効なデプロイは置き換える
      await tx.deployments.updateMany({
        where: { organization_id: actor.organizationId, agent_id: version.agent_id, stage: input.stage, status: "active" },
        data: { status: "superseded" },
      });
      const d = await tx.deployments.create({
        data: {
          organization_id: actor.organizationId,
          agent_id: version.agent_id,
          agent_version_id: version.id,
          runtime_profile_id: profile.id,
          stage: input.stage,
          compiled_config: result.config as unknown as Prisma.InputJsonValue,
          created_by: actor.userId,
        },
        include: { agent: true, agent_version: true, runtime_profile: true, build: true },
      });
      await recordAudit(
        tx,
        auditBy(actor, {
          action: "deployment.create",
          targetType: "deployment",
          targetId: d.id,
          detail: { agent_id: version.agent_id, version: version.version, stage: input.stage, profile: profile.key, warnings: result.config.warnings },
        }),
      );
      return toDeploymentDto(d);
    });
  }

  async archiveDeployment(actor: MemberActor, id: string): Promise<DeploymentDto> {
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const d = await tx.deployments.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!d) throw notFound("デプロイ");
      requireRole(actor, d.stage === "production" ? "admin" : "builder");
      const updated = await tx.deployments.update({
        where: { id },
        data: { status: "archived" },
        include: { agent: true, agent_version: true, runtime_profile: true, build: true },
      });
      await recordAudit(tx, auditBy(actor, { action: "deployment.archive", targetType: "deployment", targetId: id }));
      return toDeploymentDto(updated);
    });
  }
}

function managedTenantShort(slug: string): string {
  const normalized = slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const shortened = normalized.slice(0, 20).replace(/-+$/g, "");
  return shortened || "company";
}

function managedAccountName(slug: string, stage: string, suffix: string): string {
  return `agent-studio-${slug}-${stage}-${suffix}`.slice(0, 50).replace(/-+$/g, "");
}

function managedAccountEmail(slug: string, stage: string, suffix: string, domain: string): string {
  const local = `aws+${slug}-${stage}-${suffix}`.toLowerCase().replace(/[^a-z0-9+_.-]+/g, "-").slice(0, 64);
  return `${local}@${domain}`;
}
