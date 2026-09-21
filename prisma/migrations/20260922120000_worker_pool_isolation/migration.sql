ALTER TABLE "organizations" ADD COLUMN "worker_pool" TEXT NOT NULL DEFAULT 'production';
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_worker_pool_check" CHECK ("worker_pool" IN ('production', 'test'));

CREATE OR REPLACE FUNCTION system_claim_runs(p_owner text, p_lease_seconds integer, p_limit integer)
RETURNS TABLE (run_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE runs r
     SET stream_lease_owner = p_owner,
         stream_lease_until = now() + make_interval(secs => p_lease_seconds)
   WHERE r.id IN (
     SELECT c.id FROM runs c
     JOIN organizations o ON o.id = c.organization_id
      WHERE c.status IN ('queued', 'provisioning', 'running', 'requires_action')
        AND (c.stream_lease_until IS NULL OR c.stream_lease_until < now())
        AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN 'test' ELSE 'production' END
      ORDER BY c.created_at
      LIMIT p_limit
      FOR UPDATE OF c SKIP LOCKED
   )
  RETURNING r.id, r.organization_id
$$;

CREATE OR REPLACE FUNCTION system_claim_builder_runs(p_owner text, p_lease_seconds integer, p_limit integer)
RETURNS TABLE(builder_run_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH ready AS (
    SELECT b.id FROM builder_runs b
    JOIN organizations o ON o.id = b.organization_id
     WHERE (b.status = 'queued' OR (b.status = 'running' AND b.lease_until < now()))
       AND (b.not_before IS NULL OR b.not_before <= now())
       AND (b.budget->>'worker_id' IS NULL OR b.budget->>'worker_id' = p_owner)
       AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN 'test' ELSE 'production' END
     ORDER BY b.created_at
     FOR UPDATE OF b SKIP LOCKED
     LIMIT p_limit
  )
  UPDATE builder_runs r
     SET status = 'running', lease_owner = p_owner,
         lease_until = now() + make_interval(secs => p_lease_seconds),
         started_at = coalesce(started_at, now()), updated_at = now()
    FROM ready WHERE r.id = ready.id
  RETURNING r.id, r.organization_id
$$;

CREATE OR REPLACE FUNCTION system_claim_builder_workspace_sessions(p_owner text, p_lease_seconds integer, p_limit integer)
RETURNS TABLE(builder_session_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH ready AS (
    SELECT s.id FROM builder_workspace_sessions s
    JOIN organizations o ON o.id = s.organization_id
     WHERE s.status IN ('creating', 'waiting_worker', 'connected', 'running')
       AND (s.lease_until IS NULL OR s.lease_until < now())
       AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN 'test' ELSE 'production' END
     ORDER BY s.created_at
     FOR UPDATE OF s SKIP LOCKED
     LIMIT p_limit
  )
  UPDATE builder_workspace_sessions s
     SET lease_owner = p_owner, lease_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
    FROM ready WHERE s.id = ready.id
  RETURNING s.id, s.organization_id
$$;
REVOKE ALL ON FUNCTION system_claim_runs(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_claim_runs(text, integer, integer) TO agent_studio_app;
REVOKE ALL ON FUNCTION system_claim_builder_runs(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_claim_builder_runs(text, integer, integer) TO agent_studio_app;
REVOKE ALL ON FUNCTION system_claim_builder_workspace_sessions(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_claim_builder_workspace_sessions(text, integer, integer) TO agent_studio_app;

DROP FUNCTION system_claim_due_schedules(integer, integer);
CREATE FUNCTION system_claim_due_schedules(p_owner text, p_lease_seconds integer, p_limit integer)
RETURNS TABLE(schedule_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT s.id FROM agent_schedules s
    JOIN organizations o ON o.id = s.organization_id
    WHERE s.enabled = true AND s.next_run_at <= now() AND (s.lease_until IS NULL OR s.lease_until < now())
      AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN 'test' ELSE 'production' END
    ORDER BY s.next_run_at
    FOR UPDATE OF s SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE agent_schedules s SET lease_until = now() + make_interval(secs => p_lease_seconds)
    FROM due WHERE s.id = due.id RETURNING s.id, s.organization_id
  )
  SELECT id, organization_id FROM claimed
$$;
REVOKE ALL ON FUNCTION system_claim_due_schedules(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_claim_due_schedules(text, integer, integer) TO agent_studio_app;
