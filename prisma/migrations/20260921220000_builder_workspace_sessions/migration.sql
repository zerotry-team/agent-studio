CREATE TABLE "builder_workspace_sessions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "change_set_id" UUID NOT NULL,
  "runtime_id" UUID NOT NULL,
  "openai_session_id" TEXT,
  "openai_environment_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'creating',
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "lease_owner" TEXT,
  "lease_until" TIMESTAMPTZ(6),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "last_event_at" TIMESTAMPTZ(6),
  "prompt_hash" TEXT NOT NULL,
  "result_hash" TEXT,
  "error_class" TEXT,
  "error" TEXT,
  "token_hash" TEXT NOT NULL,
  "worker_task_arn" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ(6),
  CONSTRAINT "builder_workspace_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "builder_workspace_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "builder_workspace_sessions_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "builder_projects"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "builder_workspace_sessions_organization_id_change_set_id_fkey" FOREIGN KEY ("organization_id", "change_set_id") REFERENCES "builder_change_sets"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "builder_workspace_sessions_organization_id_runtime_id_fkey" FOREIGN KEY ("organization_id", "runtime_id") REFERENCES "runtimes"("organization_id", "id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "builder_workspace_sessions_openai_session_id_key" ON "builder_workspace_sessions"("openai_session_id");
CREATE UNIQUE INDEX "builder_workspace_sessions_change_set_id_attempt_key" ON "builder_workspace_sessions"("change_set_id", "attempt");
CREATE UNIQUE INDEX "builder_workspace_sessions_organization_id_id_key" ON "builder_workspace_sessions"("organization_id", "id");
CREATE INDEX "builder_workspace_sessions_status_lease_until_created_at_idx" ON "builder_workspace_sessions"("status", "lease_until", "created_at");
CREATE INDEX "builder_workspace_sessions_runtime_id_status_idx" ON "builder_workspace_sessions"("runtime_id", "status");

ALTER TABLE "builder_workspace_sessions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "builder_workspace_sessions"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "builder_workspace_sessions" TO agent_studio_app;

CREATE OR REPLACE FUNCTION system_claim_builder_workspace_sessions(p_owner text, p_lease_seconds integer, p_limit integer)
RETURNS TABLE(builder_session_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH ready AS (
    SELECT id FROM builder_workspace_sessions
     WHERE status IN ('creating', 'waiting_worker', 'connected', 'running')
       AND (lease_until IS NULL OR lease_until < now())
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  )
  UPDATE builder_workspace_sessions s
     SET lease_owner = p_owner,
         lease_until = now() + make_interval(secs => p_lease_seconds),
         updated_at = now()
    FROM ready
   WHERE s.id = ready.id
  RETURNING s.id, s.organization_id
$$;
REVOKE ALL ON FUNCTION system_claim_builder_workspace_sessions(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_claim_builder_workspace_sessions(text, integer, integer) TO agent_studio_app;
