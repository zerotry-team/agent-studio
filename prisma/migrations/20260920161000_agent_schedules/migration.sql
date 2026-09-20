CREATE TABLE "agent_schedules" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "agent_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "stage" TEXT NOT NULL,
  "input" TEXT NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  "local_time" TEXT NOT NULL,
  "days_of_week" JSONB NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "next_run_at" TIMESTAMPTZ(6) NOT NULL,
  "last_run_at" TIMESTAMPTZ(6),
  "last_run_id" UUID,
  "lease_until" TIMESTAMPTZ(6),
  "created_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_schedules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_schedules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "agent_schedules_organization_id_agent_id_fkey" FOREIGN KEY ("organization_id", "agent_id") REFERENCES "agents"("organization_id", "id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "agent_schedules_organization_id_id_key" ON "agent_schedules"("organization_id", "id");
CREATE INDEX "agent_schedules_enabled_next_run_at_idx" ON "agent_schedules"("enabled", "next_run_at");
ALTER TABLE "agent_schedules" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "agent_schedules"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "agent_schedules" TO agent_studio_app;

CREATE OR REPLACE FUNCTION system_claim_due_schedules(p_lease_seconds integer, p_limit integer)
RETURNS TABLE(schedule_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT id FROM agent_schedules
    WHERE enabled = true AND next_run_at <= now() AND (lease_until IS NULL OR lease_until < now())
    ORDER BY next_run_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE agent_schedules s
    SET lease_until = now() + make_interval(secs => p_lease_seconds)
    FROM due
    WHERE s.id = due.id
    RETURNING s.id, s.organization_id
  )
  SELECT id, organization_id FROM claimed
$$;
REVOKE ALL ON FUNCTION system_claim_due_schedules(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_claim_due_schedules(integer, integer) TO agent_studio_app;
