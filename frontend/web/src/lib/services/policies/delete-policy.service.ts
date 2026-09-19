import "server-only";
import { PolicyRepository } from "@/lib/repositories";

export class DeletePolicyService {
  constructor(private readonly policies = new PolicyRepository()) {}

  invoke(id: string): Promise<void> {
    return this.policies.remove(id);
  }
}
