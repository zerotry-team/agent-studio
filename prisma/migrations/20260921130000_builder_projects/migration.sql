CREATE TABLE "builder_projects" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "request" TEXT NOT NULL,
  "target" TEXT NOT NULL DEFAULT 'preview',
  "status" TEXT NOT NULL DEFAULT 'draft',
  "created_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(6),
  CONSTRAINT "builder_projects_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "builder_projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "builder_projects_organization_id_id_key" ON "builder_projects"("organization_id", "id");
CREATE INDEX "builder_projects_organization_id_updated_at_idx" ON "builder_projects"("organization_id", "updated_at" DESC);

CREATE TABLE "builder_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "attempt" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "budget" JSONB NOT NULL DEFAULT '{}',
  "correlation_id" UUID NOT NULL,
  "lease_owner" TEXT,
  "lease_until" TIMESTAMPTZ(6),
  "error_class" TEXT,
  "error" TEXT,
  "started_at" TIMESTAMPTZ(6),
  "finished_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "builder_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "builder_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "builder_runs_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "builder_projects"("organization_id", "id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "builder_runs_organization_id_id_key" ON "builder_runs"("organization_id", "id");
CREATE UNIQUE INDEX "builder_runs_project_id_attempt_key" ON "builder_runs"("project_id", "attempt");
CREATE INDEX "builder_runs_status_lease_until_created_at_idx" ON "builder_runs"("status", "lease_until", "created_at");

CREATE TABLE "builder_steps" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "input_hash" TEXT NOT NULL,
  "output" JSONB,
  "error_class" TEXT,
  "error" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "started_at" TIMESTAMPTZ(6),
  "finished_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "builder_steps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "builder_steps_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "builder_steps_organization_id_run_id_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "builder_runs"("organization_id", "id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "builder_steps_run_id_kind_key" ON "builder_steps"("run_id", "kind");
CREATE UNIQUE INDEX "builder_steps_organization_id_id_key" ON "builder_steps"("organization_id", "id");

CREATE TABLE "capability_plans" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "requirements" JSONB NOT NULL,
  "graph" JSONB NOT NULL,
  "risks" JSONB NOT NULL DEFAULT '[]',
  "execution_locations" JSONB NOT NULL DEFAULT '[]',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "capability_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capability_plans_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "capability_plans_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "builder_projects"("organization_id", "id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "capability_plans_project_id_version_key" ON "capability_plans"("project_id", "version");
CREATE UNIQUE INDEX "capability_plans_organization_id_id_key" ON "capability_plans"("organization_id", "id");

CREATE TABLE "capability_gaps" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "requirement" TEXT NOT NULL,
  "gap_type" TEXT NOT NULL,
  "resolution_strategy" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "detail" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "capability_gaps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capability_gaps_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "capability_gaps_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "builder_projects"("organization_id", "id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "capability_gaps_organization_id_id_key" ON "capability_gaps"("organization_id", "id");
CREATE INDEX "capability_gaps_project_id_status_idx" ON "capability_gaps"("project_id", "status");

CREATE TABLE "human_actions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "assignee_role" TEXT NOT NULL,
  "fields" JSONB NOT NULL DEFAULT '[]',
  "instructions" JSONB NOT NULL DEFAULT '[]',
  "resume_condition" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "completed_by" UUID,
  "completed_at" TIMESTAMPTZ(6),
  "expires_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "human_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "human_actions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "human_actions_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "builder_projects"("organization_id", "id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "human_actions_organization_id_id_key" ON "human_actions"("organization_id", "id");
CREATE INDEX "human_actions_project_id_status_idx" ON "human_actions"("project_id", "status");

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'builder_projects', 'builder_runs', 'builder_steps', 'capability_plans', 'capability_gaps', 'human_actions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())',
      t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO agent_studio_app', t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION system_claim_builder_runs(p_owner text, p_lease_seconds integer, p_limit integer)
RETURNS TABLE(builder_run_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH ready AS (
    SELECT id FROM builder_runs
     WHERE (status = 'queued' OR (status = 'running' AND lease_until < now()))
       AND (budget->>'worker_id' IS NULL OR budget->>'worker_id' = p_owner)
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  )
  UPDATE builder_runs r
     SET status = 'running',
         lease_owner = p_owner,
         lease_until = now() + make_interval(secs => p_lease_seconds),
         started_at = coalesce(started_at, now()),
         updated_at = now()
    FROM ready
   WHERE r.id = ready.id
  RETURNING r.id, r.organization_id
$$;
REVOKE ALL ON FUNCTION system_claim_builder_runs(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_claim_builder_runs(text, integer, integer) TO agent_studio_app;
