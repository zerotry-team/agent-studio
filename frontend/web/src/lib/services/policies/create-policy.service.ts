import "server-only";
import { createPolicySchema, type CreatePolicyInput, type PolicyDto } from "@agent-studio/contracts";
import { PolicyRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

export class CreatePolicyService {
  constructor(private readonly policies = new PolicyRepository()) {}

  invoke(input: CreatePolicyInput): Promise<PolicyDto> {
    return this.policies.create(parseInput(createPolicySchema, input));
  }
}
