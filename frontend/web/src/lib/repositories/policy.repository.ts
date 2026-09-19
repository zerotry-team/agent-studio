import "server-only";
import type { Policy, PolicyDto } from "@agent-studio/contracts";
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
}
