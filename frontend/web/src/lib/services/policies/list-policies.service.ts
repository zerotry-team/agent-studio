import "server-only";
import type { PolicyDto } from "@agent-studio/contracts";
import { PolicyRepository } from "@/lib/repositories";

export class ListPoliciesService {
  constructor(private readonly policies = new PolicyRepository()) {}

  invoke(): Promise<PolicyDto[]> {
    return this.policies.list();
  }
}
