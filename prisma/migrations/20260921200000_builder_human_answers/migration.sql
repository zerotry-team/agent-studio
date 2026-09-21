ALTER TABLE "human_actions" ADD COLUMN "response" JSONB;

COMMENT ON COLUMN "human_actions"."response" IS 'Business clarification answers only. Secret values must use Connection Secret Store.';
