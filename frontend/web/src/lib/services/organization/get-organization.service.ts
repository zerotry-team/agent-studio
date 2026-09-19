import "server-only";
import type { OrganizationDto } from "@agent-studio/contracts";
import { OrganizationRepository } from "@/lib/repositories";

export class GetOrganizationService {
  constructor(private readonly organizations = new OrganizationRepository()) {}

  invoke(): Promise<OrganizationDto> {
    return this.organizations.get();
  }
}
