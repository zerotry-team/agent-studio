CREATE TABLE "builder_discovery_sources" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "spec_version" TEXT,
  "source_url" TEXT,
  "content_hash" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "builder_discovery_sources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "builder_discovery_sources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "builder_discovery_sources_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "builder_projects"("organization_id", "id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "builder_discovery_sources_organization_id_id_key" ON "builder_discovery_sources"("organization_id", "id");
CREATE INDEX "builder_discovery_sources_project_id_created_at_idx" ON "builder_discovery_sources"("project_id", "created_at" DESC);

CREATE TABLE "builder_change_sets" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "risk" TEXT NOT NULL,
  "artifacts" JSONB NOT NULL DEFAULT '[]',
  "source_hash" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "builder_change_sets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "builder_change_sets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "builder_change_sets_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "builder_projects"("organization_id", "id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "builder_change_sets_organization_id_id_key" ON "builder_change_sets"("organization_id", "id");
CREATE INDEX "builder_change_sets_project_id_created_at_idx" ON "builder_change_sets"("project_id", "created_at" DESC);

CREATE TABLE "builder_validation_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "suite" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "evidence" JSONB NOT NULL DEFAULT '{}',
  "error_class" TEXT,
  "error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ(6),
  CONSTRAINT "builder_validation_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "builder_validation_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "builder_validation_runs_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "builder_projects"("organization_id", "id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "builder_validation_runs_organization_id_id_key" ON "builder_validation_runs"("organization_id", "id");
CREATE INDEX "builder_validation_runs_project_id_created_at_idx" ON "builder_validation_runs"("project_id", "created_at" DESC);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['builder_discovery_sources', 'builder_change_sets', 'builder_validation_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())',
      t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO agent_studio_app', t);
  END LOOP;
END $$;
