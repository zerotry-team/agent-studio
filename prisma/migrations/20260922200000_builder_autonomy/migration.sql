-- Builder Agentが連携サービス・実行環境を自動設定するための補助列。
-- いずれも既存のRLS付きテーブルへの列追加で、Secretは保存しない。
ALTER TABLE "connectors" ADD COLUMN "provider_key" TEXT;
ALTER TABLE "human_actions" ADD COLUMN "presentation" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "capability_plans" ADD COLUMN "environment_plan" JSONB;

-- 既存のQiita / Social Router / Browser Connectorはカタログ由来として扱う
UPDATE "connectors" SET "provider_key" = "key" WHERE "provider_key" IS NULL AND "key" IN ('qiita', 'social-router', 'browser-automation', 'slack', 'notion', 'freee', 'kintone', 'google-drive', 'google-sheets');
