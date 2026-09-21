import "server-only";
import type { AutoApprovalPolicyDto, Policy, PolicyDto, SetAutoApprovalEmergencyStopInput, UpdateAutoApprovalPolicyInput } from "@agent-studio/contracts";
import { ApiRepository } from "./base";

export class PolicyRepository extends ApiRepository {
  list(): Promise<PolicyDto[]> {
    return this.api.get<PolicyDto[]>("/policies");
  }

  create(input: { name: string; rule: Policy; enabled: boolean }): Promise<PolicyDto> {
    return this.api.post<PolicyDto>("/policies", input);
  }

  update(id: string, input: { rule?: Policy; enabled?: boolean }): Promise<PolicyDto> {
    return this.api.patch<PolicyDto>(`/policies/${encodeURIComponent(id)}`, input);
  }

  remove(id: string): Promise<void> {
    return this.api.delete(`/policies/${encodeURIComponent(id)}`);
  }

  getAutoApproval(): Promise<AutoApprovalPolicyDto> {
    return this.api.get<AutoApprovalPolicyDto>("/organization/auto-approval-policy");
  }

  setAutoApproval(input: UpdateAutoApprovalPolicyInput): Promise<AutoApprovalPolicyDto> {
    return this.api.put<AutoApprovalPolicyDto>("/organization/auto-approval-policy", input);
  }

  setAutoApprovalEmergencyStop(input: SetAutoApprovalEmergencyStopInput): Promise<AutoApprovalPolicyDto> {
    return this.api.post<AutoApprovalPolicyDto>("/organization/auto-approval-policy/emergency-stop", input);
  }
}
