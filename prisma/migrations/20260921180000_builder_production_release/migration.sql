ALTER TABLE builder_releases
  ADD COLUMN production_deployment_id uuid,
  ADD COLUMN production_run_id uuid,
  ADD COLUMN rollback_target_deployment_id uuid;

CREATE INDEX builder_releases_production_run_id_idx ON builder_releases(production_run_id);

CREATE OR REPLACE FUNCTION system_list_active_builder_production_runs(p_limit integer)
RETURNS TABLE(builder_release_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.organization_id
    FROM builder_releases r
   WHERE r.status = 'production_running'
   ORDER BY r.created_at
   LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION system_list_active_builder_production_runs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_list_active_builder_production_runs(integer) TO agent_studio_app;
