ALTER TABLE "organization_openai_settings"
ADD COLUMN "orcarouter_key_secret_arn" TEXT,
ADD COLUMN "orcarouter_text_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "orcarouter_image_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "orcarouter_text_model" TEXT NOT NULL DEFAULT 'google/gemini-2.5-pro',
ADD COLUMN "orcarouter_image_model" TEXT NOT NULL DEFAULT 'openai/gpt-image-1';
