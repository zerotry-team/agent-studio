-- Studio-managed Runtime provisioning is resumable and organization-scoped.
-- The AWS account does not exist yet when the request is accepted, so the
-- account id is nullable until Organizations finishes CreateAccount.
ALTER TABLE "runtimes"
  ALTER COLUMN "aws_account_id" DROP NOT NULL,
  ADD COLUMN "provisioning_status" TEXT,
  ADD COLUMN "provisioning_step" TEXT,
  ADD COLUMN "provisioning_progress" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "provisioning_error" TEXT,
  ADD COLUMN "provisioning_request_id" TEXT,
  ADD COLUMN "provisioning_account_name" TEXT,
  ADD COLUMN "provisioning_account_email" TEXT,
  ADD COLUMN "provisioning_tenant_short" TEXT,
  ADD COLUMN "provisioning_outputs" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "provisioning_lease_owner" TEXT,
  ADD COLUMN "provisioning_lease_until" TIMESTAMPTZ(6),
  ADD COLUMN "provisioning_started_at" TIMESTAMPTZ(6),
  ADD COLUMN "provisioning_completed_at" TIMESTAMPTZ(6),
  ADD COLUMN "provisioning_attempts" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "runtimes"
  ADD CONSTRAINT "runtimes_provisioning_progress_check"
    CHECK ("provisioning_progress" BETWEEN 0 AND 100),
  ADD CONSTRAINT "runtimes_provisioning_status_check"
    CHECK ("provisioning_status" IS NULL OR "provisioning_status" IN (
      'queued', 'account_creating', 'infrastructure_applying',
      'bootstrap_configuring', 'connecting', 'completed', 'failed'
    ));

CREATE INDEX "runtimes_provisioning_status_provisioning_lease_until_created_at_idx"
  ON "runtimes"("provisioning_status", "provisioning_lease_until", "created_at");

CREATE OR REPLACE FUNCTION system_claim_managed_runtime_provisioning(
  p_owner text,
  p_lease_seconds integer,
  p_limit integer
)
RETURNS TABLE(runtime_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH ready AS (
    SELECT r.id
      FROM runtimes r
      JOIN organizations o ON o.id = r.organization_id
     WHERE r.provisioning_type = 'studio_managed'
       AND r.provisioning_status IN (
         'queued', 'account_creating', 'infrastructure_applying',
         'bootstrap_configuring', 'connecting'
       )
       AND (r.provisioning_lease_until IS NULL OR r.provisioning_lease_until < now())
       AND o.worker_pool = CASE WHEN p_owner LIKE 'test-%' THEN p_owner ELSE 'production' END
     ORDER BY r.created_at
     FOR UPDATE OF r SKIP LOCKED
     LIMIT p_limit
  )
  UPDATE runtimes r
     SET provisioning_lease_owner = p_owner,
         provisioning_lease_until = now() + make_interval(secs => p_lease_seconds),
         provisioning_started_at = coalesce(provisioning_started_at, now()),
         updated_at = now()
    FROM ready
   WHERE r.id = ready.id
  RETURNING r.id, r.organization_id
$$;

REVOKE ALL ON FUNCTION system_claim_managed_runtime_provisioning(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_claim_managed_runtime_provisioning(text, integer, integer) TO agent_studio_app;
