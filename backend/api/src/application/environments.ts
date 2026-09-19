import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  createRuntimeProfileSchema,
  type AgentManifest,
  type BootstrapTokenDto,
  type CreateDeploymentInput,
  type CreateRuntimeInput,
  type CreateRuntimeProfileInput,
  type DeploymentDto,
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
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      // 同じ AWS プリンシパルは全組織を通じて1つの Runtime にしか使えない（一意制約で 409 になる）
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
      if (r.status === "revoked" || r.status === "pending") throw preconditionFailed("登録済みの Runtime にだけ配布できます");
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
          include: { agent: true, agent_version: true, runtime_profile: true },
          orderBy: { created_at: "desc" },
          take: 200,
        })
      ).map(toDeploymentDto),
    );
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
        include: { agent: true, agent_version: true, runtime_profile: true },
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
        include: { agent: true, agent_version: true, runtime_profile: true },
      });
      await recordAudit(tx, auditBy(actor, { action: "deployment.archive", targetType: "deployment", targetId: id }));
      return toDeploymentDto(updated);
    });
  }
}
