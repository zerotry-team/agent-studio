ALTER TABLE "builder_runs"
  ADD COLUMN "error_fingerprint" TEXT,
  ADD COLUMN "retryable" BOOLEAN,
  ADD COLUMN "next_action" TEXT,
  ADD COLUMN "not_before" TIMESTAMPTZ(6),
  ADD COLUMN "last_evidence_id" UUID;

DROP INDEX IF EXISTS "builder_runs_status_lease_until_created_at_idx";
CREATE INDEX "builder_runs_status_not_before_lease_until_created_at_idx"
  ON "builder_runs"("status", "not_before", "lease_until", "created_at");

CREATE OR REPLACE FUNCTION system_claim_builder_runs(p_owner text, p_lease_seconds integer, p_limit integer)
RETURNS TABLE(builder_run_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH ready AS (
    SELECT id FROM builder_runs
     WHERE (status = 'queued' OR (status = 'running' AND lease_until < now()))
       AND (not_before IS NULL OR not_before <= now())
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
