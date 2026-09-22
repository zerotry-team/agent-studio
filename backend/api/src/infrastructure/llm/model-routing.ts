import { preconditionFailed } from "../../domain/errors.js";
import type { Env } from "../../env.js";
import type { SecretStore } from "../secrets/secret-store.js";

export const DEFAULT_ORCAROUTER_TEXT_MODEL = "google/gemini-2.5-pro";
export const DEFAULT_ORCAROUTER_IMAGE_MODEL = "openai/gpt-image-1";

type RoutingSettings = {
  openai_project_id: string | null;
  app_key_secret_arn: string | null;
  orcarouter_key_secret_arn: string | null;
  orcarouter_text_enabled: boolean;
  orcarouter_image_enabled: boolean;
  orcarouter_text_model: string;
  orcarouter_image_model: string;
};

export type ModelRoute = {
  provider: "openai" | "orcarouter";
  apiKey: string;
  model: string;
  baseURL?: string;
  project?: string;
};

export function configuredApiKey(value: string | null | undefined): string | null {
  const key = value?.trim();
  return key && key !== "unset" ? key : null;
}

export async function resolveModelRoute(input: {
  capability: "text" | "image";
  settings: RoutingSettings | null;
  env: Pick<Env, "NODE_ENV" | "OPENAI_API_KEY" | "ORCAROUTER_API_KEY" | "ORCAROUTER_BASE_URL">;
  secrets: SecretStore;
  openAiModel: string;
}): Promise<ModelRoute> {
  const enabled = input.capability === "text"
    ? input.settings?.orcarouter_text_enabled === true
    : input.settings?.orcarouter_image_enabled === true;

  if (enabled) {
    const organizationKey = input.settings?.orcarouter_key_secret_arn
      ? configuredApiKey(await input.secrets.get(input.settings.orcarouter_key_secret_arn))
      : null;
    const apiKey = organizationKey ?? configuredApiKey(input.env.ORCAROUTER_API_KEY);
    if (!apiKey) {
      throw preconditionFailed("Orca Router が有効ですが、APIキーが設定されていません。設定でチェックを外すと従来のOpenAIを使用します");
    }
    const model = input.capability === "text"
      ? input.settings?.orcarouter_text_model || DEFAULT_ORCAROUTER_TEXT_MODEL
      : input.settings?.orcarouter_image_model || DEFAULT_ORCAROUTER_IMAGE_MODEL;
    return { provider: "orcarouter", apiKey, baseURL: input.env.ORCAROUTER_BASE_URL, model };
  }

  const organizationKey = input.settings?.app_key_secret_arn
    ? configuredApiKey(await input.secrets.get(input.settings.app_key_secret_arn))
    : null;
  const apiKey = organizationKey ?? (input.env.NODE_ENV !== "production" ? configuredApiKey(input.env.OPENAI_API_KEY) : null);
  if (!apiKey) throw preconditionFailed("OpenAIの接続が未設定です。設定から接続してください");
  return {
    provider: "openai",
    apiKey,
    model: input.openAiModel,
    ...(input.settings?.openai_project_id ? { project: input.settings.openai_project_id } : {}),
  };
}
