import type { Prisma } from "@prisma/client";
import type { Tx } from "./db/tenant-db.js";

export type AuditActorType = "user" | "runtime" | "system";
export type AuditResult = "success" | "failure" | "denied";

export interface AuditEntry {
  organizationId: string | null;
  actorType: AuditActorType;
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  result?: AuditResult;
  detail?: Record<string, unknown>;
  sourceIp?: string | null;
}

/**
 * 監査ログ（AUD-01）。INSERT ... RETURNING は RLS の SELECT 条件にかかるため createMany で書く。
 * 組織の文脈（app.organization_id）と organization_id が一致しないと RLS で拒否される。
 */
export async function recordAudit(tx: Tx, entries: AuditEntry | AuditEntry[]): Promise<void> {
  const list = Array.isArray(entries) ? entries : [entries];
  if (list.length === 0) return;
  await tx.audit_logs.createMany({
    data: list.map((e) => ({
      organization_id: e.organizationId,
      actor_type: e.actorType,
      actor_id: e.actorId ?? null,
      actor_label: e.actorLabel ?? null,
      action: e.action,
      target_type: e.targetType ?? null,
      target_id: e.targetId ?? null,
      result: e.result ?? "success",
      detail: (e.detail ?? {}) as Prisma.InputJsonValue,
      source_ip: e.sourceIp ?? null,
    })),
  });
}
