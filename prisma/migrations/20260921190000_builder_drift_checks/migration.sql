CREATE OR REPLACE FUNCTION system_list_builder_releases_for_drift(p_limit integer)
RETURNS TABLE(builder_release_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.organization_id
    FROM builder_releases r
   WHERE r.status = 'production_succeeded'
     AND NOT EXISTS (
       SELECT 1 FROM builder_validation_runs v
        WHERE v.project_id = r.project_id
          AND v.suite = 'drift'
          AND v.created_at > now() - interval '5 minutes'
     )
   ORDER BY r.created_at
   LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION system_list_builder_releases_for_drift(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_list_builder_releases_for_drift(integer) TO agent_studio_app;
