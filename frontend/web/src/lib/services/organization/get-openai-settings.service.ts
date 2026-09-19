import "server-only";
import type { OpenAiSettingsDto } from "@agent-studio/contracts";
import { OrganizationRepository } from "@/lib/repositories";

export class GetOpenAiSettingsService {
  constructor(private readonly organizations = new OrganizationRepository()) {}

  invoke(): Promise<OpenAiSettingsDto> {
    return this.organizations.getOpenAiSettings();
  }
}
