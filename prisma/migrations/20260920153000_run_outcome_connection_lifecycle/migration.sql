ALTER TABLE "connections"
  ADD COLUMN "expires_at" TIMESTAMPTZ(6);

ALTER TABLE "runs"
  ADD COLUMN "outcome" TEXT NOT NULL DEFAULT 'pending';

UPDATE "runs"
SET "outcome" = CASE
  WHEN "status" = 'failed' THEN 'failed'
  WHEN "status" = 'cancelled' THEN 'cancelled'
  WHEN "status" = 'completed' AND EXISTS (
    SELECT 1
    FROM "run_events"
    WHERE "run_events"."run_id" = "runs"."id"
      AND "run_events"."type" = 'tool.call'
      AND "run_events"."data"->>'status' = 'failed'
  ) THEN 'completed_with_errors'
  WHEN "status" = 'completed' THEN 'succeeded'
  ELSE 'pending'
END;

CREATE INDEX "connections_status_expires_at_idx"
  ON "connections" ("status", "expires_at");

CREATE OR REPLACE FUNCTION system_expire_connections()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  UPDATE connections
  SET status = 'expired', updated_at = now()
  WHERE status = 'connected' AND expires_at IS NOT NULL AND expires_at <= now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION system_expire_connections() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_expire_connections() TO agent_studio_app;

CREATE TABLE "external_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "connector_id" UUID NOT NULL,
  "source_tool" TEXT NOT NULL,
  "poll_tool" TEXT NOT NULL,
  "provider_job_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "response" JSONB,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_poll_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_checked_at" TIMESTAMPTZ(6),
  "error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "external_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "external_jobs_organization_id_run_id_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "runs"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "external_jobs_organization_id_connector_id_fkey" FOREIGN KEY ("organization_id", "connector_id") REFERENCES "connectors"("organization_id", "id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "external_jobs_organization_id_connector_id_provider_job_id_key" ON "external_jobs"("organization_id", "connector_id", "provider_job_id");
CREATE UNIQUE INDEX "external_jobs_organization_id_id_key" ON "external_jobs"("organization_id", "id");
CREATE INDEX "external_jobs_status_next_poll_at_idx" ON "external_jobs"("status", "next_poll_at");
ALTER TABLE "external_jobs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "external_jobs"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "external_jobs" TO agent_studio_app;

CREATE OR REPLACE FUNCTION system_list_external_jobs(p_limit integer)
RETURNS TABLE(job_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, organization_id
  FROM external_jobs
  WHERE status IN ('pending', 'processing') AND next_poll_at <= now()
  ORDER BY next_poll_at
  LIMIT p_limit
$$;

REVOKE ALL ON FUNCTION system_list_external_jobs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_list_external_jobs(integer) TO agent_studio_app;
