import "server-only";
import { setOpenAiCredentialsSchema, type OpenAiSettingsDto } from "@agent-studio/contracts";
import { OrganizationRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

export interface UpdateOpenAiSettingsInput {
  openai_project_id: string;
  /** 空欄なら変更しない */
  app_api_key?: string;
  /** 空欄なら変更しない */
  environment_api_key?: string;
}

/** OpenAI の Project ID とキーを設定する。キーは書き込み専用で、空欄の項目は変更しない */
export class UpdateOpenAiSettingsService {
  constructor(private readonly organizations = new OrganizationRepository()) {}

  invoke(input: UpdateOpenAiSettingsInput): Promise<OpenAiSettingsDto> {
    const payload = parseInput(setOpenAiCredentialsSchema, {
      openai_project_id: input.openai_project_id.trim(),
      app_api_key: input.app_api_key?.trim() || undefined,
      environment_api_key: input.environment_api_key?.trim() || undefined,
    });
    return this.organizations.setOpenAiSettings(payload);
  }
}
