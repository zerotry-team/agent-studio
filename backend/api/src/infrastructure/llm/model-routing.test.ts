import { describe, expect, it } from "vitest";
import { MemorySecretStore } from "../secrets/secret-store.js";
import { resolveModelRoute } from "./model-routing.js";

const env = {
  NODE_ENV: "production" as const,
  OPENAI_API_KEY: undefined,
  ORCAROUTER_API_KEY: undefined,
  ORCAROUTER_BASE_URL: "https://api.orcarouter.ai/v1",
};

const baseSettings = {
  openai_project_id: "proj_existing",
  app_key_secret_arn: "openai-ref",
  orcarouter_key_secret_arn: "orca-ref",
  orcarouter_text_enabled: false,
  orcarouter_image_enabled: false,
  orcarouter_text_model: "anthropic/claude-sonnet-4.6",
  orcarouter_image_model: "google/imagen-4.0-generate-001",
};

describe("optional model routing", () => {
  it("Orcaのキーが存在してもチェックOFFなら従来のOpenAIを使う", async () => {
    const secrets = new MemorySecretStore();
    const openAiRef = await secrets.put("openai-ref", "openai-key");
    const orcaRef = await secrets.put("orca-ref", "sk-orca-key");
    const route = await resolveModelRoute({
      capability: "text",
      settings: { ...baseSettings, app_key_secret_arn: openAiRef, orcarouter_key_secret_arn: orcaRef },
      env,
      secrets,
      openAiModel: "gpt-existing",
    });
    expect(route).toEqual({ provider: "openai", apiKey: "openai-key", model: "gpt-existing", project: "proj_existing" });
  });

  it("テキストだけONなら画像はOpenAIのまま維持する", async () => {
    const secrets = new MemorySecretStore();
    const openAiRef = await secrets.put("openai-ref", "openai-key");
    const orcaRef = await secrets.put("orca-ref", "sk-orca-key");
    const settings = { ...baseSettings, app_key_secret_arn: openAiRef, orcarouter_key_secret_arn: orcaRef, orcarouter_text_enabled: true };

    await expect(resolveModelRoute({ capability: "text", settings, env, secrets, openAiModel: "gpt-existing" })).resolves.toEqual({
      provider: "orcarouter",
      apiKey: "sk-orca-key",
      baseURL: "https://api.orcarouter.ai/v1",
      model: "anthropic/claude-sonnet-4.6",
    });
    await expect(resolveModelRoute({ capability: "image", settings, env, secrets, openAiModel: "gpt-image-existing" })).resolves.toEqual({
      provider: "openai",
      apiKey: "openai-key",
      model: "gpt-image-existing",
      project: "proj_existing",
    });
  });

  it("チェックONでOrcaキーが無い場合はOpenAIへ黙って流さない", async () => {
    const secrets = new MemorySecretStore();
    const openAiRef = await secrets.put("openai-ref", "openai-key");
    await expect(resolveModelRoute({
      capability: "image",
      settings: { ...baseSettings, app_key_secret_arn: openAiRef, orcarouter_key_secret_arn: null, orcarouter_image_enabled: true },
      env,
      secrets,
      openAiModel: "gpt-image-existing",
    })).rejects.toThrow(/チェックを外すと従来のOpenAI/);
  });
});
