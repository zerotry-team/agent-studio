CREATE TABLE "builder_releases" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "builder_run_id" UUID NOT NULL,
  "agent_id" UUID NOT NULL,
  "build_id" UUID NOT NULL,
  "preview_deployment_id" UUID NOT NULL,
  "preview_run_id" UUID,
  "status" TEXT NOT NULL DEFAULT 'preview_ready',
  "config_hash" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ(6),
  CONSTRAINT "builder_releases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "builder_releases_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "builder_releases_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "builder_projects"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "builder_releases_organization_id_builder_run_id_fkey" FOREIGN KEY ("organization_id", "builder_run_id") REFERENCES "builder_runs"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "builder_releases_organization_id_agent_id_fkey" FOREIGN KEY ("organization_id", "agent_id") REFERENCES "agents"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "builder_releases_organization_id_build_id_fkey" FOREIGN KEY ("organization_id", "build_id") REFERENCES "agent_builds"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "builder_releases_organization_id_preview_deployment_id_fkey" FOREIGN KEY ("organization_id", "preview_deployment_id") REFERENCES "deployments"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "builder_releases_organization_id_preview_run_id_fkey" FOREIGN KEY ("organization_id", "preview_run_id") REFERENCES "runs"("organization_id", "id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "builder_releases_organization_id_id_key" ON "builder_releases"("organization_id", "id");
CREATE UNIQUE INDEX "builder_releases_builder_run_id_key" ON "builder_releases"("builder_run_id");
CREATE INDEX "builder_releases_project_id_created_at_idx" ON "builder_releases"("project_id", "created_at" DESC);
CREATE INDEX "builder_releases_status_created_at_idx" ON "builder_releases"("status", "created_at");

ALTER TABLE "builder_releases" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "builder_releases"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "builder_releases" TO agent_studio_app;

CREATE OR REPLACE FUNCTION system_list_active_builder_previews(p_limit integer)
RETURNS TABLE(builder_release_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.organization_id
    FROM builder_releases r
   WHERE r.status = 'preview_running'
   ORDER BY r.created_at
   LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION system_list_active_builder_previews(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_list_active_builder_previews(integer) TO agent_studio_app;
