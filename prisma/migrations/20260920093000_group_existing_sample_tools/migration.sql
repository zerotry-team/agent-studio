-- AV-020 backward-compatible data migration: group the existing Sample A tools
-- without changing their immutable versions, schemas, risk, or manifest names.
INSERT INTO "connectors" (
  "organization_id", "key", "name", "description", "adapter", "auth_type"
)
SELECT DISTINCT
  t."organization_id",
  'sample-a-product-api',
  'Sample A社 商品API',
  '商品情報の参照と価格変更に利用する社内サービス',
  'runtime',
  'runtime_secret'
FROM "tools" t
WHERE t."name" IN ('get_product', 'update_price')
ON CONFLICT ("organization_id", "key") DO NOTHING;

UPDATE "tools" t
SET "connector_id" = c."id"
FROM "connectors" c
WHERE c."organization_id" = t."organization_id"
  AND c."key" = 'sample-a-product-api'
  AND t."name" IN ('get_product', 'update_price')
  AND t."connector_id" IS NULL;
