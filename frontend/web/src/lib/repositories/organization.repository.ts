import "server-only";
import type {
  CreateOrganizationInput,
  OpenAiSettingsDto,
  OrganizationDto,
  SetOpenAiCredentialsInput,
} from "@agent-studio/contracts";
import { ApiRepository } from "./base";

export class OrganizationRepository extends ApiRepository {
  get(): Promise<OrganizationDto> {
    return this.api.get<OrganizationDto>("/organization");
  }

  update(input: { name: string }): Promise<OrganizationDto> {
    return this.api.patch<OrganizationDto>("/organization", input);
  }

  getOpenAiSettings(): Promise<OpenAiSettingsDto> {
    return this.api.get<OpenAiSettingsDto>("/organization/openai");
  }

  setOpenAiSettings(input: SetOpenAiCredentialsInput): Promise<OpenAiSettingsDto> {
    return this.api.put<OpenAiSettingsDto>("/organization/openai", input);
  }

  /** 運営管理者のみ（組織ヘッダ不要） */
  create(input: CreateOrganizationInput): Promise<OrganizationDto> {
    return this.api.post<OrganizationDto>("/admin/organizations", input);
  }
}
