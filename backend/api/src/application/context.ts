import { hasRoleAtLeast, type MemberRole } from "@agent-studio/contracts";
import { forbidden } from "../domain/errors.js";
import type { AuditEntry } from "../infrastructure/audit.js";
import type { TenantScope } from "../infrastructure/db/tenant-db.js";

/** ログインしている利用者 */
export interface UserActor {
  userId: string;
  email: string;
  isPlatformAdmin: boolean;
  sourceIp: string | null;
}

/** 組織を選んで操作している利用者（メンバーシップはサーバーで確認済み） */
export interface MemberActor extends UserActor {
  organizationId: string;
  role: MemberRole;
  isApprover: boolean;
}

export function scopeOf(actor: UserActor | MemberActor): TenantScope {
  return { organizationId: "organizationId" in actor ? actor.organizationId : null, userId: actor.userId };
}

export function requireRole(actor: MemberActor, role: MemberRole): void {
  if (!hasRoleAtLeast(actor.role, role)) throw forbidden();
}

export function requireApprover(actor: MemberActor): void {
  if (!actor.isApprover) throw forbidden("承認の権限がありません");
}

export function auditBy(actor: MemberActor, entry: Omit<AuditEntry, "organizationId" | "actorType" | "actorId" | "actorLabel" | "sourceIp">): AuditEntry {
  return {
    organizationId: actor.organizationId,
    actorType: "user",
    actorId: actor.userId,
    actorLabel: actor.email,
    sourceIp: actor.sourceIp,
    ...entry,
  };
}
