CREATE TABLE "deployment_api_keys" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "deployment_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "key_prefix" TEXT NOT NULL,
  "key_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "rate_limit_per_minute" INTEGER NOT NULL DEFAULT 60,
  "max_runs_per_day" INTEGER NOT NULL DEFAULT 1000,
  "last_used_at" TIMESTAMPTZ(6),
  "expires_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "created_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "deployment_api_keys_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "deployment_api_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "deployment_api_keys_organization_id_deployment_id_fkey" FOREIGN KEY ("organization_id", "deployment_id") REFERENCES "deployments"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "deployment_api_keys_limits_check" CHECK ("rate_limit_per_minute" BETWEEN 1 AND 600 AND "max_runs_per_day" BETWEEN 1 AND 100000)
);
CREATE UNIQUE INDEX "deployment_api_keys_key_hash_key" ON "deployment_api_keys"("key_hash");
CREATE UNIQUE INDEX "deployment_api_keys_organization_id_id_key" ON "deployment_api_keys"("organization_id", "id");
CREATE INDEX "deployment_api_keys_deployment_id_status_idx" ON "deployment_api_keys"("deployment_id", "status");

CREATE TABLE "deployment_webhooks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "deployment_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "secret_locator" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "rate_limit_per_minute" INTEGER NOT NULL DEFAULT 60,
  "max_runs_per_day" INTEGER NOT NULL DEFAULT 1000,
  "last_used_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "created_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "deployment_webhooks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "deployment_webhooks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "deployment_webhooks_organization_id_deployment_id_fkey" FOREIGN KEY ("organization_id", "deployment_id") REFERENCES "deployments"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "deployment_webhooks_limits_check" CHECK ("rate_limit_per_minute" BETWEEN 1 AND 600 AND "max_runs_per_day" BETWEEN 1 AND 100000)
);
CREATE UNIQUE INDEX "deployment_webhooks_organization_id_id_key" ON "deployment_webhooks"("organization_id", "id");
CREATE INDEX "deployment_webhooks_deployment_id_status_idx" ON "deployment_webhooks"("deployment_id", "status");

CREATE TABLE "deployment_trigger_invocations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "deployment_id" UUID NOT NULL,
  "credential_type" TEXT NOT NULL,
  "credential_id" UUID NOT NULL,
  "delivery_id" TEXT,
  "request_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "run_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "deployment_trigger_invocations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "deployment_trigger_invocations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "deployment_trigger_invocations_organization_id_deployment_id_fkey" FOREIGN KEY ("organization_id", "deployment_id") REFERENCES "deployments"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "deployment_trigger_invocations_organization_id_run_id_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "runs"("organization_id", "id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "deployment_trigger_invocations_organization_id_id_key" ON "deployment_trigger_invocations"("organization_id", "id");
CREATE UNIQUE INDEX "deployment_trigger_invocations_credential_type_credential_id_delivery_id_key" ON "deployment_trigger_invocations"("credential_type", "credential_id", "delivery_id");
CREATE INDEX "deployment_trigger_invocations_credential_id_created_at_idx" ON "deployment_trigger_invocations"("credential_id", "created_at" DESC);
CREATE INDEX "deployment_trigger_invocations_deployment_id_created_at_idx" ON "deployment_trigger_invocations"("deployment_id", "created_at" DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['deployment_api_keys', 'deployment_webhooks', 'deployment_trigger_invocations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO agent_studio_app', t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION system_resolve_deployment_api_key(p_key_hash text)
RETURNS TABLE(id uuid, organization_id uuid, deployment_id uuid, rate_limit_per_minute integer, max_runs_per_day integer)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT k.id, k.organization_id, k.deployment_id, k.rate_limit_per_minute, k.max_runs_per_day
  FROM deployment_api_keys k
  JOIN deployments d ON d.organization_id = k.organization_id AND d.id = k.deployment_id
  WHERE k.key_hash = p_key_hash AND k.status = 'active' AND k.revoked_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at > now())
    AND d.stage = 'production' AND d.status = 'active' AND d.health_status = 'ready'
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION system_resolve_deployment_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_resolve_deployment_api_key(text) TO agent_studio_app;

CREATE OR REPLACE FUNCTION system_resolve_deployment_webhook(p_id uuid)
RETURNS TABLE(id uuid, organization_id uuid, deployment_id uuid, secret_locator text, rate_limit_per_minute integer, max_runs_per_day integer)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT w.id, w.organization_id, w.deployment_id, w.secret_locator, w.rate_limit_per_minute, w.max_runs_per_day
  FROM deployment_webhooks w
  JOIN deployments d ON d.organization_id = w.organization_id AND d.id = w.deployment_id
  WHERE w.id = p_id AND w.status = 'active' AND w.revoked_at IS NULL
    AND d.stage = 'production' AND d.status = 'active' AND d.health_status = 'ready'
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION system_resolve_deployment_webhook(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_resolve_deployment_webhook(uuid) TO agent_studio_app;
