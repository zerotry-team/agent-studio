CREATE TABLE "organization_auto_approval_policies" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "config" JSONB NOT NULL,
  "emergency_stopped_at" TIMESTAMPTZ(6),
  "created_by" UUID,
  "updated_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "organization_auto_approval_policies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_auto_approval_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "organization_auto_approval_policies_version_check" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX "organization_auto_approval_policies_organization_id_key" ON "organization_auto_approval_policies"("organization_id");
CREATE UNIQUE INDEX "organization_auto_approval_policies_organization_id_id_key" ON "organization_auto_approval_policies"("organization_id", "id");

CREATE TABLE "organization_auto_approval_policy_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "policy_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "config" JSONB NOT NULL,
  "created_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "organization_auto_approval_policy_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_auto_approval_policy_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "organization_auto_approval_policy_versions_policy_fkey" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "organization_auto_approval_policies"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "organization_auto_approval_policy_versions_version_check" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX "organization_auto_approval_policy_versions_policy_id_version_key" ON "organization_auto_approval_policy_versions"("policy_id", "version");
CREATE UNIQUE INDEX "organization_auto_approval_policy_versions_organization_id_id_key" ON "organization_auto_approval_policy_versions"("organization_id", "id");

ALTER TABLE "approvals"
  ADD COLUMN "auto_approved" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "auto_approval_policy_id" UUID,
  ADD COLUMN "auto_approval_policy_version" INTEGER,
  ADD COLUMN "auto_approval_reason" TEXT;

ALTER TABLE "approvals" ADD CONSTRAINT "approvals_auto_policy_pair_check"
  CHECK (("auto_approved" = false AND "auto_approval_policy_id" IS NULL AND "auto_approval_policy_version" IS NULL)
    OR ("auto_approved" = true AND "auto_approval_policy_id" IS NOT NULL AND "auto_approval_policy_version" IS NOT NULL));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organization_auto_approval_policies', 'organization_auto_approval_policy_versions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO agent_studio_app', t);
  END LOOP;
END $$;
