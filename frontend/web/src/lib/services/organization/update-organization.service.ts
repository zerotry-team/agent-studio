import "server-only";
import { updateOrganizationSchema, type OrganizationDto } from "@agent-studio/contracts";
import { OrganizationRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

export class UpdateOrganizationService {
  constructor(private readonly organizations = new OrganizationRepository()) {}

  invoke(input: { name: string }): Promise<OrganizationDto> {
    return this.organizations.update(parseInput(updateOrganizationSchema, input));
  }
}
