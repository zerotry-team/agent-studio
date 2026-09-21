ALTER TABLE "connections"
ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "builder_change_sets"
ADD COLUMN "base_sha" TEXT,
ADD COLUMN "head_sha" TEXT,
ADD COLUMN "pr_url" TEXT,
ADD COLUMN "pr_number" INTEGER,
ADD COLUMN "merge_sha" TEXT;

ALTER TABLE "runtime_jobs"
ADD COLUMN "credential_consumed_at" TIMESTAMPTZ(6);

CREATE TABLE "builder_adapter_packages" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "change_set_id" UUID NOT NULL,
  "runtime_id" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "connector_key" TEXT NOT NULL,
  "descriptor_hash" TEXT NOT NULL,
  "contract_hash" TEXT NOT NULL,
  "source_commit" TEXT NOT NULL,
  "image_digest" TEXT NOT NULL,
  "signature" TEXT NOT NULL,
  "provenance" JSONB NOT NULL DEFAULT '{}',
  "health_status" TEXT NOT NULL DEFAULT 'pending',
  "error_class" TEXT,
  "error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deployed_at" TIMESTAMPTZ(6),
  "registered_at" TIMESTAMPTZ(6),
  CONSTRAINT "builder_adapter_packages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "builder_adapter_packages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "builder_adapter_packages_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "builder_projects"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "builder_adapter_packages_organization_id_change_set_id_fkey" FOREIGN KEY ("organization_id", "change_set_id") REFERENCES "builder_change_sets"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "builder_adapter_packages_organization_id_runtime_id_fkey" FOREIGN KEY ("organization_id", "runtime_id") REFERENCES "runtimes"("organization_id", "id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "builder_adapter_packages_change_set_id_key" ON "builder_adapter_packages"("change_set_id");
CREATE UNIQUE INDEX "builder_adapter_packages_organization_id_id_key" ON "builder_adapter_packages"("organization_id", "id");
CREATE UNIQUE INDEX "builder_adapter_packages_organization_id_connector_key_image_digest_key" ON "builder_adapter_packages"("organization_id", "connector_key", "image_digest");
CREATE INDEX "builder_adapter_packages_runtime_id_status_idx" ON "builder_adapter_packages"("runtime_id", "status");

CREATE TABLE "git_webhook_deliveries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "delivery_id" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "repository_id" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "git_webhook_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "git_webhook_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "git_webhook_deliveries_organization_id_delivery_id_key" ON "git_webhook_deliveries"("organization_id", "delivery_id");
CREATE UNIQUE INDEX "git_webhook_deliveries_organization_id_id_key" ON "git_webhook_deliveries"("organization_id", "id");

ALTER TABLE "builder_adapter_packages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "builder_adapter_packages"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "builder_adapter_packages" TO agent_studio_app;

ALTER TABLE "git_webhook_deliveries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "git_webhook_deliveries"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "git_webhook_deliveries" TO agent_studio_app;

CREATE OR REPLACE FUNCTION system_list_github_connections(p_repository_id text)
RETURNS TABLE(connection_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, organization_id
    FROM connections
   WHERE status = 'connected'
     AND revoked_at IS NULL
     AND metadata->>'provider' = 'github_app'
     AND metadata->>'repository_id' = p_repository_id
$$;
REVOKE ALL ON FUNCTION system_list_github_connections(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_list_github_connections(text) TO agent_studio_app;
