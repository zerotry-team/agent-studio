import "server-only";
import { updatePolicySchema, type PolicyDto, type UpdatePolicyInput } from "@agent-studio/contracts";
import { PolicyRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

export class UpdatePolicyService {
  constructor(private readonly policies = new PolicyRepository()) {}

  invoke(id: string, input: UpdatePolicyInput): Promise<PolicyDto> {
    return this.policies.update(id, parseInput(updatePolicySchema, input));
  }
}
