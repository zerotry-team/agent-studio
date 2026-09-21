import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  autoApprovalPolicyConfigSchema,
  hasRoleAtLeast,
  type CreateOrganizationInput,
  type CreatePolicyInput,
  type InviteMemberInput,
  type MeDto,
  type MemberDto,
  type MemberRole,
  type OpenAiSettingsDto,
  type OrganizationDto,
  type PolicyDto,
  type SetOpenAiCredentialsInput,
  type UpdateMemberInput,
  type UpdatePolicyInput,
  type AutoApprovalPolicyDto,
  type SetAutoApprovalEmergencyStopInput,
  type UpdateAutoApprovalPolicyInput,
  policySchema,
} from "@agent-studio/contracts";
import { conflict, forbidden, notFound, preconditionFailed } from "../domain/errors.js";
import { recordAudit } from "../infrastructure/audit.js";
import type { Tx } from "../infrastructure/db/tenant-db.js";
import { secretNames } from "../infrastructure/secrets/secret-store.js";
import { auditBy, requireRole, scopeOf, type MemberActor, type UserActor } from "./context.js";
import type { Deps } from "./deps.js";
import { toOrganizationDto, toPolicyDto } from "./dto.js";

export class OrganizationService {
  constructor(private readonly deps: Deps) {}

  /** ログイン中の利用者と所属組織（組織ヘッダ不要） */
  async me(actor: UserActor): Promise<MeDto> {
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const user = await tx.users.findUniqueOrThrow({ where: { id: actor.userId } });
      const memberships = await tx.organization_members.findMany({
        where: { user_id: actor.userId },
        include: { organization: true },
        orderBy: { created_at: "asc" },
      });
      return {
        user: { id: user.id, email: user.email, display_name: user.display_name, is_platform_admin: user.is_platform_admin },
        memberships: memberships
          .filter((m) => m.organization.status === "active")
          .map((m) => ({
            organization: toOrganizationDto(m.organization),
            role: m.role as MemberRole,
            is_approver: m.is_approver,
          })),
      };
    });
  }

  /** 組織を作る（運営管理者のみ）。最初の owner を招待し、OpenAI Project を紐づける（ORG-08） */
  async create(actor: UserActor, input: CreateOrganizationInput): Promise<OrganizationDto> {
    if (!actor.isPlatformAdmin) throw forbidden("組織を作成できるのは運営管理者だけです");
    const organizationId = randomUUID();
    // 認証基盤への登録（招待メール）を先に行う。失敗したら組織も作らない
    await this.deps.inviter.invite(input.owner_email);
    return this.deps.db.run({ organizationId, userId: actor.userId }, async (tx) => {
      // slug の重複は一意制約の違反（409）になる。RLS で他組織は見えないため事前確認はしない
      const org = await tx.organizations.create({ data: { id: organizationId, slug: input.slug, name: input.name } });
      const ownerId = await this.deps.system.inviteResolveUser(tx, input.owner_email);
      await tx.organization_members.create({
        data: { organization_id: organizationId, user_id: ownerId, role: "owner", is_approver: true },
      });
      await tx.organization_openai_settings.create({
        data: { organization_id: organizationId, openai_project_id: input.openai_project_id ?? null },
      });
      await recordAudit(tx, {
        organizationId,
        actorType: "user",
        actorId: actor.userId,
        actorLabel: actor.email,
        sourceIp: actor.sourceIp,
        action: "organization.create",
        targetType: "organization",
        targetId: organizationId,
        detail: { slug: input.slug, owner_email: input.owner_email },
      });
      return toOrganizationDto(org);
    });
  }

  async get(actor: MemberActor): Promise<OrganizationDto> {
    return this.deps.db.run(scopeOf(actor), async (tx) =>
      toOrganizationDto(await tx.organizations.findUniqueOrThrow({ where: { id: actor.organizationId } })),
    );
  }

  async update(actor: MemberActor, input: { name: string }): Promise<OrganizationDto> {
    requireRole(actor, "owner");
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const org = await tx.organizations.update({ where: { id: actor.organizationId }, data: { name: input.name } });
      await recordAudit(tx, auditBy(actor, { action: "organization.update", targetType: "organization", targetId: org.id, detail: input }));
      return toOrganizationDto(org);
    });
  }

  // ---------------------------------------------------------------------------
  // メンバー
  // ---------------------------------------------------------------------------
  async listMembers(actor: MemberActor): Promise<MemberDto[]> {
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const members = await tx.organization_members.findMany({
        where: { organization_id: actor.organizationId },
        include: { user: true },
        orderBy: { created_at: "asc" },
      });
      return members.map((m) => ({
        user_id: m.user_id,
        email: m.user.email,
        display_name: m.user.display_name,
        role: m.role as MemberRole,
        is_approver: m.is_approver,
        created_at: m.created_at.toISOString(),
      }));
    });
  }

  async inviteMember(actor: MemberActor, input: InviteMemberInput): Promise<MemberDto> {
    requireRole(actor, "admin");
    if (input.role === "owner") requireRole(actor, "owner");
    await this.deps.inviter.invite(input.email);
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const userId = await this.deps.system.inviteResolveUser(tx, input.email);
      const existing = await tx.organization_members.findUnique({
        where: { organization_id_user_id: { organization_id: actor.organizationId, user_id: userId } },
      });
      if (existing) throw conflict("このメールアドレスの利用者はすでにメンバーです");
      const member = await tx.organization_members.create({
        data: { organization_id: actor.organizationId, user_id: userId, role: input.role, is_approver: input.is_approver ?? false },
        include: { user: true },
      });
      await recordAudit(tx, auditBy(actor, { action: "member.invite", targetType: "user", targetId: userId, detail: { email: input.email, role: input.role } }));
      return {
        user_id: userId,
        email: member.user.email,
        display_name: member.user.display_name,
        role: member.role as MemberRole,
        is_approver: member.is_approver,
        created_at: member.created_at.toISOString(),
      };
    });
  }

  async updateMember(actor: MemberActor, userId: string, input: UpdateMemberInput): Promise<MemberDto> {
    requireRole(actor, "admin");
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const member = await tx.organization_members.findUnique({
        where: { organization_id_user_id: { organization_id: actor.organizationId, user_id: userId } },
      });
      if (!member) throw notFound("メンバー");
      // owner の付与・変更は owner だけ
      if ((member.role === "owner" || input.role === "owner") && !hasRoleAtLeast(actor.role, "owner")) throw forbidden();
      if (member.role === "owner" && input.role && input.role !== "owner") await this.assertAnotherOwner(tx, actor.organizationId, userId);
      const updated = await tx.organization_members.update({
        where: { organization_id_user_id: { organization_id: actor.organizationId, user_id: userId } },
        data: { ...(input.role ? { role: input.role } : {}), ...(input.is_approver !== undefined ? { is_approver: input.is_approver } : {}) },
        include: { user: true },
      });
      await recordAudit(tx, auditBy(actor, { action: "member.update", targetType: "user", targetId: userId, detail: input }));
      return {
        user_id: userId,
        email: updated.user.email,
        display_name: updated.user.display_name,
        role: updated.role as MemberRole,
        is_approver: updated.is_approver,
        created_at: updated.created_at.toISOString(),
      };
    });
  }

  async removeMember(actor: MemberActor, userId: string): Promise<void> {
    requireRole(actor, "admin");
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      const member = await tx.organization_members.findUnique({
        where: { organization_id_user_id: { organization_id: actor.organizationId, user_id: userId } },
      });
      if (!member) throw notFound("メンバー");
      if (member.role === "owner") {
        requireRole(actor, "owner");
        await this.assertAnotherOwner(tx, actor.organizationId, userId);
      }
      await tx.organization_members.delete({
        where: { organization_id_user_id: { organization_id: actor.organizationId, user_id: userId } },
      });
      await recordAudit(tx, auditBy(actor, { action: "member.remove", targetType: "user", targetId: userId }));
    });
  }

  private async assertAnotherOwner(tx: Tx, organizationId: string, exceptUserId: string) {
    const owners = await tx.organization_members.count({
      where: { organization_id: organizationId, role: "owner", user_id: { not: exceptUserId } },
    });
    if (owners === 0) throw preconditionFailed("owner が1人もいなくなるため、変更できません");
  }

  // ---------------------------------------------------------------------------
  // OpenAI（組織ごとの Project とキー。SEC-11）
  // ---------------------------------------------------------------------------
  async getOpenAiSettings(actor: MemberActor): Promise<OpenAiSettingsDto> {
    requireRole(actor, "admin");
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const s = await tx.organization_openai_settings.findUnique({ where: { organization_id: actor.organizationId } });
      return {
        openai_project_id: s?.openai_project_id ?? null,
        has_app_api_key: Boolean(s?.app_key_secret_arn),
        has_environment_api_key: Boolean(s?.env_key_secret_arn),
        updated_at: s?.updated_at.toISOString() ?? null,
      };
    });
  }

  async setOpenAiSettings(actor: MemberActor, input: SetOpenAiCredentialsInput): Promise<OpenAiSettingsDto> {
    requireRole(actor, "owner");
    const { env, secrets } = this.deps;
    const tags = { "agentstudio:organization_id": actor.organizationId };
    // Secrets Manager への書き込みはトランザクションの外で行う
    const appKeyArn = input.app_api_key
      ? await secrets.put(secretNames.openAiAppKey(env.SECRETS_PREFIX, actor.organizationId), input.app_api_key, tags)
      : undefined;
    const envKeyArn = input.environment_api_key
      ? await secrets.put(secretNames.openAiEnvKey(env.SECRETS_PREFIX, actor.organizationId), input.environment_api_key, tags)
      : undefined;

    const result = await this.deps.db.run(scopeOf(actor), async (tx) => {
      const data = {
        openai_project_id: input.openai_project_id,
        ...(appKeyArn ? { app_key_secret_arn: appKeyArn } : {}),
        ...(envKeyArn ? { env_key_secret_arn: envKeyArn } : {}),
      };
      const s = await tx.organization_openai_settings.upsert({
        where: { organization_id: actor.organizationId },
        create: { organization_id: actor.organizationId, ...data },
        update: data,
      });
      if (envKeyArn) {
        // 環境キーを変えたら、有効な Runtime に配り直す
        const runtimes = await tx.runtimes.findMany({
          where: { organization_id: actor.organizationId, status: { in: ["active", "degraded", "offline"] } },
        });
        for (const r of runtimes) {
          await tx.runtime_jobs.create({
            data: {
              organization_id: actor.organizationId,
              runtime_id: r.id,
              type: "rotate_environment_key",
              payload: { type: "rotate_environment_key" } as Prisma.InputJsonValue,
            },
          });
        }
      }
      await recordAudit(
        tx,
        auditBy(actor, {
          action: "openai_settings.update",
          targetType: "organization",
          targetId: actor.organizationId,
          detail: { openai_project_id: input.openai_project_id, app_key_updated: Boolean(appKeyArn), environment_key_updated: Boolean(envKeyArn) },
        }),
      );
      return {
        openai_project_id: s.openai_project_id,
        has_app_api_key: Boolean(s.app_key_secret_arn),
        has_environment_api_key: Boolean(s.env_key_secret_arn),
        updated_at: s.updated_at.toISOString(),
      };
    });
    this.deps.agentsApi.invalidate(actor.organizationId);
    return result;
  }

  // ---------------------------------------------------------------------------
  // 組織全体のポリシー（POL-06）
  // ---------------------------------------------------------------------------
  async listPolicies(actor: MemberActor): Promise<PolicyDto[]> {
    return this.deps.db.run(scopeOf(actor), async (tx) =>
      (await tx.policies.findMany({ where: { organization_id: actor.organizationId }, orderBy: { created_at: "asc" } })).map(toPolicyDto),
    );
  }

  async createPolicy(actor: MemberActor, input: CreatePolicyInput): Promise<PolicyDto> {
    requireRole(actor, "admin");
    const rule = policySchema.parse(input.rule);
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const dup = await tx.policies.findUnique({ where: { organization_id_name: { organization_id: actor.organizationId, name: input.name } } });
      if (dup) throw conflict("同じ名前のポリシーがあります");
      const p = await tx.policies.create({
        data: { organization_id: actor.organizationId, name: input.name, rule: rule as Prisma.InputJsonValue, enabled: input.enabled ?? true },
      });
      await recordAudit(tx, auditBy(actor, { action: "policy.create", targetType: "policy", targetId: p.id, detail: { name: p.name, rule } }));
      return toPolicyDto(p);
    });
  }

  async updatePolicy(actor: MemberActor, id: string, input: UpdatePolicyInput): Promise<PolicyDto> {
    requireRole(actor, "admin");
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const existing = await tx.policies.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!existing) throw notFound("ポリシー");
      const p = await tx.policies.update({
        where: { id },
        data: {
          ...(input.rule ? { rule: policySchema.parse(input.rule) as Prisma.InputJsonValue } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        },
      });
      await recordAudit(tx, auditBy(actor, { action: "policy.update", targetType: "policy", targetId: id, detail: input as Record<string, unknown> }));
      return toPolicyDto(p);
    });
  }

  async deletePolicy(actor: MemberActor, id: string): Promise<void> {
    requireRole(actor, "admin");
    await this.deps.db.run(scopeOf(actor), async (tx) => {
      const existing = await tx.policies.findFirst({ where: { id, organization_id: actor.organizationId } });
      if (!existing) throw notFound("ポリシー");
      await tx.policies.delete({ where: { id } });
      await recordAudit(tx, auditBy(actor, { action: "policy.delete", targetType: "policy", targetId: id, detail: { name: existing.name } }));
    });
  }

  // ---------------------------------------------------------------------------
  // 組織の自動承認Policy
  // ---------------------------------------------------------------------------
  async getAutoApprovalPolicy(actor: MemberActor): Promise<AutoApprovalPolicyDto> {
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const policy = await tx.organization_auto_approval_policies.findUnique({ where: { organization_id: actor.organizationId } });
      if (!policy) {
        return {
          id: null,
          version: 0,
          config: autoApprovalPolicyConfigSchema.parse({}),
          emergency_stopped_at: null,
          created_at: null,
          updated_at: null,
        };
      }
      return {
        id: policy.id,
        version: policy.version,
        config: autoApprovalPolicyConfigSchema.parse(policy.config),
        emergency_stopped_at: policy.emergency_stopped_at?.toISOString() ?? null,
        created_at: policy.created_at.toISOString(),
        updated_at: policy.updated_at.toISOString(),
      };
    });
  }

  async setAutoApprovalPolicy(actor: MemberActor, raw: UpdateAutoApprovalPolicyInput): Promise<AutoApprovalPolicyDto> {
    const config = autoApprovalPolicyConfigSchema.parse(raw);
    requireRole(actor, config.mode === "full_autonomy" ? "owner" : "admin");
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const existing = await tx.organization_auto_approval_policies.findUnique({ where: { organization_id: actor.organizationId } });
      const version = (existing?.version ?? 0) + 1;
      const policy = existing
        ? await tx.organization_auto_approval_policies.update({
            where: { id: existing.id },
            data: { version, config: config as Prisma.InputJsonValue, updated_by: actor.userId },
          })
        : await tx.organization_auto_approval_policies.create({
            data: {
              organization_id: actor.organizationId,
              version,
              config: config as Prisma.InputJsonValue,
              created_by: actor.userId,
              updated_by: actor.userId,
            },
          });
      await tx.organization_auto_approval_policy_versions.create({
        data: {
          organization_id: actor.organizationId,
          policy_id: policy.id,
          version,
          config: config as Prisma.InputJsonValue,
          created_by: actor.userId,
        },
      });
      await recordAudit(tx, auditBy(actor, {
        action: "auto_approval_policy.update",
        targetType: "auto_approval_policy",
        targetId: policy.id,
        detail: { version, mode: config.mode, environments: config.environments, allowed_operations: config.allowed_operations },
      }));
      return {
        id: policy.id,
        version: policy.version,
        config,
        emergency_stopped_at: policy.emergency_stopped_at?.toISOString() ?? null,
        created_at: policy.created_at.toISOString(),
        updated_at: policy.updated_at.toISOString(),
      };
    });
  }

  async setAutoApprovalEmergencyStop(actor: MemberActor, input: SetAutoApprovalEmergencyStopInput): Promise<AutoApprovalPolicyDto> {
    requireRole(actor, "admin");
    return this.deps.db.run(scopeOf(actor), async (tx) => {
      const existing = await tx.organization_auto_approval_policies.findUnique({ where: { organization_id: actor.organizationId } });
      if (!existing) throw preconditionFailed("自動承認Policyを先に保存してください");
      const policy = await tx.organization_auto_approval_policies.update({
        where: { id: existing.id },
        data: { emergency_stopped_at: input.stopped ? new Date() : null, updated_by: actor.userId },
      });
      await recordAudit(tx, auditBy(actor, {
        action: input.stopped ? "auto_approval_policy.emergency_stop" : "auto_approval_policy.resume",
        targetType: "auto_approval_policy",
        targetId: policy.id,
        detail: { version: policy.version },
      }));
      return {
        id: policy.id,
        version: policy.version,
        config: autoApprovalPolicyConfigSchema.parse(policy.config),
        emergency_stopped_at: policy.emergency_stopped_at?.toISOString() ?? null,
        created_at: policy.created_at.toISOString(),
        updated_at: policy.updated_at.toISOString(),
      };
    });
  }
}
