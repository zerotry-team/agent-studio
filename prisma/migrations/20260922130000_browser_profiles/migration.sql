CREATE TABLE "browser_profiles" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL, "runtime_id" UUID NOT NULL,
  "project_id" UUID, "provider_key" TEXT NOT NULL, "display_name" TEXT NOT NULL, "environment" TEXT NOT NULL,
  "allowed_domains" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending', "runtime_object_key" TEXT,
  "last_verified_at" TIMESTAMPTZ(6), "expires_at" TIMESTAMPTZ(6), "revoked_at" TIMESTAMPTZ(6),
  "created_by" UUID, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "browser_profiles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "browser_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "browser_profiles_runtime_fkey" FOREIGN KEY ("organization_id", "runtime_id") REFERENCES "runtimes"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "browser_profiles_project_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "builder_projects"("organization_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "browser_profiles_environment_check" CHECK ("environment" IN ('staging', 'production')),
  CONSTRAINT "browser_profiles_status_check" CHECK ("status" IN ('pending', 'active', 'expired', 'revoked'))
);
CREATE UNIQUE INDEX "browser_profiles_organization_id_id_key" ON "browser_profiles"("organization_id", "id");
CREATE INDEX "browser_profiles_organization_id_provider_key_environment_status_idx" ON "browser_profiles"("organization_id", "provider_key", "environment", "status");

CREATE TABLE "browser_login_sessions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL, "profile_id" UUID NOT NULL,
  "runtime_id" UUID NOT NULL, "project_id" UUID, "human_action_id" UUID, "runtime_job_id" UUID,
  "status" TEXT NOT NULL DEFAULT 'pending', "relay_token_hash" TEXT NOT NULL, "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "completed_at" TIMESTAMPTZ(6), "error" TEXT, "created_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "browser_login_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "browser_login_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "browser_login_sessions_profile_fkey" FOREIGN KEY ("organization_id", "profile_id") REFERENCES "browser_profiles"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "browser_login_sessions_status_check" CHECK ("status" IN ('pending', 'running', 'succeeded', 'failed', 'cancelled', 'expired'))
);
CREATE UNIQUE INDEX "browser_login_sessions_organization_id_id_key" ON "browser_login_sessions"("organization_id", "id");
CREATE UNIQUE INDEX "browser_login_sessions_runtime_job_id_key" ON "browser_login_sessions"("runtime_job_id");
CREATE INDEX "browser_login_sessions_profile_id_status_idx" ON "browser_login_sessions"("profile_id", "status");
CREATE INDEX "browser_login_sessions_expires_at_idx" ON "browser_login_sessions"("expires_at");

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['browser_profiles', 'browser_login_sessions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO agent_studio_app', t);
  END LOOP;
END $$;
