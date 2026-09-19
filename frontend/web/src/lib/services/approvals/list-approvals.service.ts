import "server-only";
import type { ApprovalDto, ApprovalStatus } from "@agent-studio/contracts";
import { ApprovalRepository } from "@/lib/repositories";

export class ListApprovalsService {
  constructor(private readonly approvals = new ApprovalRepository()) {}

  /** status を省略するとすべて（履歴を含む） */
  invoke(query: { status?: ApprovalStatus } = {}): Promise<ApprovalDto[]> {
    return this.approvals.list(query);
  }
}
