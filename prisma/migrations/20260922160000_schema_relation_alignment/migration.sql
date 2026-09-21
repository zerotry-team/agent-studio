-- Keep manually-created relations aligned with Prisma's referential-action
-- defaults. The initial migrations intentionally use tenant-scoped compound
-- foreign keys, so this migration preserves their names and only adds the
-- missing ON UPDATE behavior (and makes Run deletion fail closed for the
-- immutable deployment invocation ledger).

ALTER TABLE "browser_login_sessions"
  DROP CONSTRAINT "browser_login_sessions_organization_id_fkey",
  DROP CONSTRAINT "browser_login_sessions_profile_fkey";

ALTER TABLE "browser_profiles"
  DROP CONSTRAINT "browser_profiles_organization_id_fkey",
  DROP CONSTRAINT "browser_profiles_project_fkey",
  DROP CONSTRAINT "browser_profiles_runtime_fkey";

ALTER TABLE "deployment_api_keys"
  DROP CONSTRAINT "deployment_api_keys_organization_id_deployment_id_fkey",
  DROP CONSTRAINT "deployment_api_keys_organization_id_fkey";

ALTER TABLE "deployment_trigger_invocations"
  DROP CONSTRAINT "deployment_trigger_invocations_organization_id_deployment_id_fk",
  DROP CONSTRAINT "deployment_trigger_invocations_organization_id_fkey",
  DROP CONSTRAINT "deployment_trigger_invocations_organization_id_run_id_fkey";

ALTER TABLE "deployment_webhooks"
  DROP CONSTRAINT "deployment_webhooks_organization_id_deployment_id_fkey",
  DROP CONSTRAINT "deployment_webhooks_organization_id_fkey";

ALTER TABLE "organization_auto_approval_policies"
  DROP CONSTRAINT "organization_auto_approval_policies_organization_id_fkey";

ALTER TABLE "organization_auto_approval_policy_versions"
  DROP CONSTRAINT "organization_auto_approval_policy_versions_organization_id_fkey",
  DROP CONSTRAINT "organization_auto_approval_policy_versions_policy_fkey";

ALTER TABLE "run_artifacts"
  DROP CONSTRAINT "run_artifacts_organization_id_fkey",
  DROP CONSTRAINT "run_artifacts_organization_id_run_id_fkey";

ALTER TABLE "organization_auto_approval_policies"
  ADD CONSTRAINT "organization_auto_approval_policies_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "organization_auto_approval_policy_versions"
  ADD CONSTRAINT "organization_auto_approval_policy_versions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "organization_auto_approval_policy_versions_policy_fkey"
    FOREIGN KEY ("organization_id", "policy_id")
    REFERENCES "organization_auto_approval_policies"("organization_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "run_artifacts"
  ADD CONSTRAINT "run_artifacts_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "run_artifacts_organization_id_run_id_fkey"
    FOREIGN KEY ("organization_id", "run_id") REFERENCES "runs"("organization_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "browser_profiles"
  ADD CONSTRAINT "browser_profiles_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "browser_profiles_runtime_fkey"
    FOREIGN KEY ("organization_id", "runtime_id") REFERENCES "runtimes"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "browser_profiles_project_fkey"
    FOREIGN KEY ("organization_id", "project_id") REFERENCES "builder_projects"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "browser_login_sessions"
  ADD CONSTRAINT "browser_login_sessions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "browser_login_sessions_profile_fkey"
    FOREIGN KEY ("organization_id", "profile_id") REFERENCES "browser_profiles"("organization_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "deployment_api_keys"
  ADD CONSTRAINT "deployment_api_keys_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "deployment_api_keys_organization_id_deployment_id_fkey"
    FOREIGN KEY ("organization_id", "deployment_id") REFERENCES "deployments"("organization_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "deployment_webhooks"
  ADD CONSTRAINT "deployment_webhooks_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "deployment_webhooks_organization_id_deployment_id_fkey"
    FOREIGN KEY ("organization_id", "deployment_id") REFERENCES "deployments"("organization_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "deployment_trigger_invocations"
  ADD CONSTRAINT "deployment_trigger_invocations_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "deployment_trigger_invocations_organization_id_deployment_id_fk"
    FOREIGN KEY ("organization_id", "deployment_id") REFERENCES "deployments"("organization_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "deployment_trigger_invocations_organization_id_run_id_fkey"
    FOREIGN KEY ("organization_id", "run_id") REFERENCES "runs"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
