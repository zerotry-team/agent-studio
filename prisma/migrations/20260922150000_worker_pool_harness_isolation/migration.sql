-- Each integration harness owns a unique worker pool. A shared `test` pool lets
-- a later suite consume retryable jobs left by an earlier suite.
ALTER TABLE organizations DROP CONSTRAINT organizations_worker_pool_check;
UPDATE organizations SET worker_pool = 'production' WHERE worker_pool = 'test';
ALTER TABLE organizations ADD CONSTRAINT organizations_worker_pool_check
  CHECK (worker_pool = 'production' OR worker_pool LIKE 'test-%');

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
        AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN p_owner ELSE 'production' END
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
      AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN p_owner ELSE 'production' END
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
      AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN p_owner ELSE 'production' END
    ORDER BY s.created_at
    FOR UPDATE OF s SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE builder_workspace_sessions s
     SET lease_owner = p_owner, lease_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
    FROM ready WHERE s.id = ready.id
  RETURNING s.id, s.organization_id
$$;

CREATE OR REPLACE FUNCTION system_claim_due_schedules(p_owner text, p_lease_seconds integer, p_limit integer)
RETURNS TABLE(schedule_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT s.id FROM agent_schedules s
    JOIN organizations o ON o.id = s.organization_id
    WHERE s.enabled = true AND s.next_run_at <= now() AND (s.lease_until IS NULL OR s.lease_until < now())
      AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN p_owner ELSE 'production' END
    ORDER BY s.next_run_at
    FOR UPDATE OF s SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE agent_schedules s SET lease_until = now() + make_interval(secs => p_lease_seconds)
    FROM due WHERE s.id = due.id RETURNING s.id, s.organization_id
  )
  SELECT id, organization_id FROM claimed
$$;

CREATE OR REPLACE FUNCTION system_list_active_workflow_runs(p_owner text, p_limit integer)
RETURNS TABLE (workflow_run_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT w.id, w.organization_id FROM workflow_runs w
  JOIN organizations o ON o.id = w.organization_id
  WHERE w.status IN ('running', 'waiting_external')
    AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN p_owner ELSE 'production' END
  ORDER BY w.updated_at LIMIT p_limit
$$;

CREATE OR REPLACE FUNCTION system_list_sessions_to_cleanup(p_owner text, p_limit integer)
RETURNS TABLE (session_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.organization_id FROM agent_sessions s
  JOIN runs r ON r.id = s.run_id
  JOIN organizations o ON o.id = s.organization_id
  WHERE s.ended_at IS NULL AND r.status IN ('completed', 'failed', 'cancelled')
    AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN p_owner ELSE 'production' END
  ORDER BY r.finished_at NULLS FIRST LIMIT p_limit
$$;

CREATE OR REPLACE FUNCTION system_list_running_eval_runs(p_owner text, p_limit integer)
RETURNS TABLE (eval_run_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.id, e.organization_id FROM eval_runs e
  JOIN organizations o ON o.id = e.organization_id
  WHERE e.status = 'running'
    AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN p_owner ELSE 'production' END
  ORDER BY e.created_at LIMIT p_limit
$$;

CREATE OR REPLACE FUNCTION system_list_external_jobs(p_owner text, p_limit integer)
RETURNS TABLE(job_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT j.id, j.organization_id FROM external_jobs j
  JOIN organizations o ON o.id = j.organization_id
  WHERE j.status IN ('pending', 'processing') AND j.next_poll_at <= now()
    AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN p_owner ELSE 'production' END
  ORDER BY j.next_poll_at LIMIT p_limit
$$;

CREATE OR REPLACE FUNCTION system_list_active_builder_previews(p_owner text, p_limit integer)
RETURNS TABLE(builder_release_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.organization_id FROM builder_releases r
  JOIN organizations o ON o.id = r.organization_id
  WHERE r.status = 'preview_running'
    AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN p_owner ELSE 'production' END
  ORDER BY r.created_at LIMIT p_limit
$$;

CREATE OR REPLACE FUNCTION system_list_active_builder_production_runs(p_owner text, p_limit integer)
RETURNS TABLE(builder_release_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.organization_id FROM builder_releases r
  JOIN organizations o ON o.id = r.organization_id
  WHERE r.status = 'production_running'
    AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN p_owner ELSE 'production' END
  ORDER BY r.created_at LIMIT p_limit
$$;

CREATE OR REPLACE FUNCTION system_list_builder_releases_for_drift(p_owner text, p_limit integer)
RETURNS TABLE(builder_release_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.organization_id FROM builder_releases r
  JOIN organizations o ON o.id = r.organization_id
  WHERE r.status = 'production_succeeded'
    AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN p_owner ELSE 'production' END
    AND NOT EXISTS (
      SELECT 1 FROM builder_validation_runs v
      WHERE v.project_id = r.project_id AND v.suite = 'drift'
        AND v.created_at > now() - interval '5 minutes'
    )
  ORDER BY r.created_at LIMIT p_limit
$$;
