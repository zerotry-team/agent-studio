import "server-only";
import { createOrganizationSchema, type CreateOrganizationInput, type OrganizationDto } from "@agent-studio/contracts";
import { OrganizationRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

/** 組織を作成する（運営管理者のみ） */
export class CreateOrganizationService {
  constructor(private readonly organizations = new OrganizationRepository()) {}

  invoke(input: CreateOrganizationInput): Promise<OrganizationDto> {
    const payload = parseInput(createOrganizationSchema, {
      ...input,
      openai_project_id: input.openai_project_id?.trim() || undefined,
    });
    return this.organizations.create(payload);
  }
}
