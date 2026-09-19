import "server-only";
import { approvalDecisionSchema, type ApprovalDecisionInput, type ApprovalDto } from "@agent-studio/contracts";
import { ApprovalRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

/** 承認・却下する（承認権限を持つメンバーのみ） */
export class DecideApprovalService {
  constructor(private readonly approvals = new ApprovalRepository()) {}

  invoke(approvalId: string, input: ApprovalDecisionInput): Promise<ApprovalDto> {
    const payload = parseInput(approvalDecisionSchema, {
      decision: input.decision,
      comment: input.comment?.trim() || undefined,
    });
    return this.approvals.decide(approvalId, payload);
  }
}
