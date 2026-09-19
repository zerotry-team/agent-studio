import "server-only";
import type { ApprovalDecisionInput, ApprovalDto, ApprovalStatus } from "@agent-studio/contracts";
import { ApiRepository } from "./base";

export class ApprovalRepository extends ApiRepository {
  list(query: { status?: ApprovalStatus } = {}): Promise<ApprovalDto[]> {
    return this.api.get<ApprovalDto[]>("/approvals", query);
  }

  decide(id: string, input: ApprovalDecisionInput): Promise<ApprovalDto> {
    return this.api.post<ApprovalDto>(`/approvals/${encodeURIComponent(id)}/decision`, input);
  }
}
