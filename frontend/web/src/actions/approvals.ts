"use server";

import type { ApprovalDecisionInput, ApprovalStatus } from "@agent-studio/contracts";
import { runAction } from "@/lib/api/run-action";
import { DecideApprovalService, ListApprovalsService } from "@/lib/services/approvals";

export async function listApprovalsAction(query: { status?: ApprovalStatus } = {}) {
  return runAction(() => new ListApprovalsService().invoke(query), "承認の一覧を取得できませんでした");
}

export async function decideApprovalAction(approvalId: string, input: ApprovalDecisionInput) {
  return runAction(
    () => new DecideApprovalService().invoke(approvalId, input),
    input.decision === "approve" ? "承認できませんでした" : "却下できませんでした",
  );
}
