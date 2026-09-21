-- Worker-owned polling must obey the same production/test pool boundary as queues.
DROP FUNCTION system_list_active_workflow_runs(integer);
CREATE FUNCTION system_list_active_workflow_runs(p_owner text, p_limit integer)
RETURNS TABLE (workflow_run_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT w.id, w.organization_id FROM workflow_runs w
  JOIN organizations o ON o.id = w.organization_id
  WHERE w.status IN ('running', 'waiting_external')
    AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN 'test' ELSE 'production' END
  ORDER BY w.updated_at
  LIMIT p_limit
$$;

DROP FUNCTION system_list_sessions_to_cleanup(integer);
CREATE FUNCTION system_list_sessions_to_cleanup(p_owner text, p_limit integer)
RETURNS TABLE (session_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.organization_id
  FROM agent_sessions s
  JOIN runs r ON r.id = s.run_id
  JOIN organizations o ON o.id = s.organization_id
  WHERE s.ended_at IS NULL
    AND r.status IN ('completed', 'failed', 'cancelled')
    AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN 'test' ELSE 'production' END
  ORDER BY r.finished_at NULLS FIRST
  LIMIT p_limit
$$;

DROP FUNCTION system_list_running_eval_runs(integer);
CREATE FUNCTION system_list_running_eval_runs(p_owner text, p_limit integer)
RETURNS TABLE (eval_run_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.id, e.organization_id FROM eval_runs e
  JOIN organizations o ON o.id = e.organization_id
  WHERE e.status = 'running'
    AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN 'test' ELSE 'production' END
  ORDER BY e.created_at
  LIMIT p_limit
$$;

DROP FUNCTION system_list_external_jobs(integer);
CREATE FUNCTION system_list_external_jobs(p_owner text, p_limit integer)
RETURNS TABLE(job_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT j.id, j.organization_id
  FROM external_jobs j
  JOIN organizations o ON o.id = j.organization_id
  WHERE j.status IN ('pending', 'processing') AND j.next_poll_at <= now()
    AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN 'test' ELSE 'production' END
  ORDER BY j.next_poll_at
  LIMIT p_limit
$$;

DROP FUNCTION system_list_active_builder_previews(integer);
CREATE FUNCTION system_list_active_builder_previews(p_owner text, p_limit integer)
RETURNS TABLE(builder_release_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.organization_id
  FROM builder_releases r
  JOIN organizations o ON o.id = r.organization_id
  WHERE r.status = 'preview_running'
    AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN 'test' ELSE 'production' END
  ORDER BY r.created_at
  LIMIT p_limit
$$;

DROP FUNCTION system_list_active_builder_production_runs(integer);
CREATE FUNCTION system_list_active_builder_production_runs(p_owner text, p_limit integer)
RETURNS TABLE(builder_release_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.organization_id
  FROM builder_releases r
  JOIN organizations o ON o.id = r.organization_id
  WHERE r.status = 'production_running'
    AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN 'test' ELSE 'production' END
  ORDER BY r.created_at
  LIMIT p_limit
$$;

DROP FUNCTION system_list_builder_releases_for_drift(integer);
CREATE FUNCTION system_list_builder_releases_for_drift(p_owner text, p_limit integer)
RETURNS TABLE(builder_release_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.organization_id
  FROM builder_releases r
  JOIN organizations o ON o.id = r.organization_id
  WHERE r.status = 'production_succeeded'
    AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN 'test' ELSE 'production' END
    AND NOT EXISTS (
      SELECT 1 FROM builder_validation_runs v
      WHERE v.project_id = r.project_id
        AND v.suite = 'drift'
        AND v.created_at > now() - interval '5 minutes'
    )
  ORDER BY r.created_at
  LIMIT p_limit
$$;

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'system_list_active_workflow_runs(text, integer)',
    'system_list_sessions_to_cleanup(text, integer)',
    'system_list_running_eval_runs(text, integer)',
    'system_list_external_jobs(text, integer)',
    'system_list_active_builder_previews(text, integer)',
    'system_list_active_builder_production_runs(text, integer)',
    'system_list_builder_releases_for_drift(text, integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO agent_studio_app', f);
  END LOOP;
END $$;
