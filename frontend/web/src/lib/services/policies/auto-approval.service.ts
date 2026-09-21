import {
  autoApprovalPolicyConfigSchema,
  setAutoApprovalEmergencyStopSchema,
  type AutoApprovalPolicyDto,
  type SetAutoApprovalEmergencyStopInput,
  type UpdateAutoApprovalPolicyInput,
} from "@agent-studio/contracts";
import { PolicyRepository } from "@/lib/repositories/policy.repository";
import { parseInput } from "@/lib/utils/validation";

export class GetAutoApprovalPolicyService {
  constructor(private readonly policies = new PolicyRepository()) {}
  invoke(): Promise<AutoApprovalPolicyDto> {
    return this.policies.getAutoApproval();
  }
}

export class SetAutoApprovalPolicyService {
  constructor(private readonly policies = new PolicyRepository()) {}
  invoke(input: UpdateAutoApprovalPolicyInput): Promise<AutoApprovalPolicyDto> {
    return this.policies.setAutoApproval(parseInput(autoApprovalPolicyConfigSchema, input));
  }
}

export class SetAutoApprovalEmergencyStopService {
  constructor(private readonly policies = new PolicyRepository()) {}
  invoke(input: SetAutoApprovalEmergencyStopInput): Promise<AutoApprovalPolicyDto> {
    return this.policies.setAutoApprovalEmergencyStop(parseInput(setAutoApprovalEmergencyStopSchema, input));
  }
}
import "server-only";
