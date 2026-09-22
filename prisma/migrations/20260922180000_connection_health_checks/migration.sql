-- Workerがtenant境界を越えて定期Health check対象を少量ずつclaimする。
-- last_validated_atをleaseとして先に更新し、複数Workerからの同時Provider呼び出しを防ぐ。
CREATE OR REPLACE FUNCTION system_claim_connection_health_checks(p_owner text, p_stale_seconds integer, p_limit integer)
RETURNS TABLE(connection_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH candidates AS (
    SELECT c.id, c.organization_id
    FROM connections c
    JOIN organizations o ON o.id = c.organization_id
    WHERE c.scope = 'studio'
      AND c.connector_id IS NOT NULL
      AND c.revoked_at IS NULL
      AND c.status IN ('connected', 'error')
      AND (c.last_validated_at IS NULL OR c.last_validated_at <= now() - make_interval(secs => p_stale_seconds))
      AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN p_owner ELSE 'production' END
    ORDER BY c.last_validated_at NULLS FIRST, c.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE connections c
  SET last_validated_at = now(), updated_at = now()
  FROM candidates x
  WHERE c.id = x.id
  RETURNING c.id, c.organization_id
$$;

REVOKE ALL ON FUNCTION system_claim_connection_health_checks(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_claim_connection_health_checks(text, integer, integer) TO agent_studio_app;

-- Credentialの有効性とDeployment healthを分離する。正しいCredentialでhealthyでない
-- Deploymentを呼んだ場合は、認証エラーへ潰さず409として運用原因を返す。
CREATE OR REPLACE FUNCTION system_resolve_deployment_api_key(p_key_hash text)
RETURNS TABLE(id uuid, organization_id uuid, deployment_id uuid, rate_limit_per_minute integer, max_runs_per_day integer)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT k.id, k.organization_id, k.deployment_id, k.rate_limit_per_minute, k.max_runs_per_day
  FROM deployment_api_keys k
  JOIN deployments d ON d.organization_id = k.organization_id AND d.id = k.deployment_id
  WHERE k.key_hash = p_key_hash AND k.status = 'active' AND k.revoked_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at > now())
    AND d.stage = 'production' AND d.status = 'active'
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION system_resolve_deployment_webhook(p_id uuid)
RETURNS TABLE(id uuid, organization_id uuid, deployment_id uuid, secret_locator text, rate_limit_per_minute integer, max_runs_per_day integer)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT w.id, w.organization_id, w.deployment_id, w.secret_locator, w.rate_limit_per_minute, w.max_runs_per_day
  FROM deployment_webhooks w
  JOIN deployments d ON d.organization_id = w.organization_id AND d.id = w.deployment_id
  WHERE w.id = p_id AND w.status = 'active' AND w.revoked_at IS NULL
    AND d.stage = 'production' AND d.status = 'active'
  LIMIT 1
$$;
