-- Workflow v2の永続waitを、Worker再起動後も時刻到達で再開する。
CREATE OR REPLACE FUNCTION system_list_active_workflow_runs(p_limit integer)
RETURNS TABLE (workflow_run_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT w.id, w.organization_id FROM workflow_runs w
   WHERE w.status IN ('running', 'waiting_external')
   ORDER BY w.updated_at
   LIMIT p_limit
$$;

REVOKE ALL ON FUNCTION system_list_active_workflow_runs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_list_active_workflow_runs(integer) TO agent_studio_app;
