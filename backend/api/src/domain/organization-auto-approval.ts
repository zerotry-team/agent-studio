import {
  autoApprovalPolicyConfigSchema,
  evaluateAutoApproval,
  type AutoApprovalContext,
  type AutoApprovalDecision,
} from "@agent-studio/contracts";
import type { Tx } from "../infrastructure/db/tenant-db.js";

export interface OrganizationAutoApprovalResult {
  policy: { id: string; version: number } | null;
  decision: AutoApprovalDecision;
}

/** DB上の現行versionと直近の自動承認数を同じtenant transactionで評価する。 */
export async function evaluateOrganizationAutoApproval(
  tx: Tx,
  organizationId: string,
  context: Omit<AutoApprovalContext, "callsLastMinute" | "emergencyStoppedAt">,
): Promise<OrganizationAutoApprovalResult> {
  const policy = await tx.organization_auto_approval_policies.findUnique({ where: { organization_id: organizationId } });
  if (!policy) return { policy: null, decision: { action: "manual_required", reason: "自動承認Policyが設定されていません" } };
  const callsLastMinute = await tx.approvals.count({
    where: {
      organization_id: organizationId,
      auto_approved: true,
      requested_at: { gte: new Date(context.now.getTime() - 60_000) },
    },
  });
  const config = autoApprovalPolicyConfigSchema.parse(policy.config);
  return {
    policy: { id: policy.id, version: policy.version },
    decision: evaluateAutoApproval(config, {
      ...context,
      callsLastMinute,
      emergencyStoppedAt: policy.emergency_stopped_at,
    }),
  };
}
