-- Agent版Vercel: Agent Project / Connector / immutable Build

ALTER TABLE "agents"
  ADD COLUMN "project_brief" TEXT,
  ADD COLUMN "capability_resolution" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE "connectors" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "adapter" TEXT NOT NULL,
  "base_url" TEXT,
  "auth_type" TEXT NOT NULL DEFAULT 'none',
  "icon" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "connectors_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "connectors_organization_id_key_key" ON "connectors"("organization_id", "key");
CREATE UNIQUE INDEX "connectors_organization_id_id_key" ON "connectors"("organization_id", "id");
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tools" ADD COLUMN "connector_id" UUID;
ALTER TABLE "tools" ADD CONSTRAINT "tools_organization_id_connector_id_fkey"
  FOREIGN KEY ("organization_id", "connector_id") REFERENCES "connectors"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "connections"
  ADD COLUMN "connector_id" UUID,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'connected',
  ADD COLUMN "last_validated_at" TIMESTAMPTZ(6),
  ADD COLUMN "revoked_at" TIMESTAMPTZ(6);
ALTER TABLE "connections" ADD CONSTRAINT "connections_organization_id_connector_id_fkey"
  FOREIGN KEY ("organization_id", "connector_id") REFERENCES "connectors"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "agent_connection_links" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "agent_id" UUID NOT NULL,
  "connector_id" UUID NOT NULL,
  "connection_id" UUID NOT NULL,
  "stage" TEXT NOT NULL,
  "allowed_capabilities" JSONB NOT NULL DEFAULT '[]',
  "created_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_connection_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agent_connection_links_agent_id_stage_connector_id_key" ON "agent_connection_links"("agent_id", "stage", "connector_id");
CREATE UNIQUE INDEX "agent_connection_links_organization_id_id_key" ON "agent_connection_links"("organization_id", "id");
ALTER TABLE "agent_connection_links" ADD CONSTRAINT "agent_connection_links_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_connection_links" ADD CONSTRAINT "agent_connection_links_organization_id_agent_id_fkey"
  FOREIGN KEY ("organization_id", "agent_id") REFERENCES "agents"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_connection_links" ADD CONSTRAINT "agent_connection_links_organization_id_connector_id_fkey"
  FOREIGN KEY ("organization_id", "connector_id") REFERENCES "connectors"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_connection_links" ADD CONSTRAINT "agent_connection_links_organization_id_connection_id_fkey"
  FOREIGN KEY ("organization_id", "connection_id") REFERENCES "connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "agent_environment_configs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "agent_id" UUID NOT NULL,
  "stage" TEXT NOT NULL,
  "variables" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_environment_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agent_environment_configs_agent_id_stage_key" ON "agent_environment_configs"("agent_id", "stage");
CREATE UNIQUE INDEX "agent_environment_configs_organization_id_id_key" ON "agent_environment_configs"("organization_id", "id");
ALTER TABLE "agent_environment_configs" ADD CONSTRAINT "agent_environment_configs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_environment_configs" ADD CONSTRAINT "agent_environment_configs_organization_id_agent_id_fkey"
  FOREIGN KEY ("organization_id", "agent_id") REFERENCES "agents"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "agent_builds" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "agent_id" UUID NOT NULL,
  "agent_version_id" UUID NOT NULL,
  "runtime_profile_id" UUID NOT NULL,
  "build_number" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ready',
  "resolution" JSONB NOT NULL DEFAULT '{}',
  "compiled_config" JSONB NOT NULL,
  "build_log" JSONB NOT NULL DEFAULT '[]',
  "created_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_builds_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agent_builds_agent_id_build_number_key" ON "agent_builds"("agent_id", "build_number");
CREATE UNIQUE INDEX "agent_builds_organization_id_id_key" ON "agent_builds"("organization_id", "id");
ALTER TABLE "agent_builds" ADD CONSTRAINT "agent_builds_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_builds" ADD CONSTRAINT "agent_builds_organization_id_agent_id_fkey"
  FOREIGN KEY ("organization_id", "agent_id") REFERENCES "agents"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_builds" ADD CONSTRAINT "agent_builds_organization_id_agent_version_id_fkey"
  FOREIGN KEY ("organization_id", "agent_version_id") REFERENCES "agent_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_builds" ADD CONSTRAINT "agent_builds_organization_id_runtime_profile_id_fkey"
  FOREIGN KEY ("organization_id", "runtime_profile_id") REFERENCES "runtime_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "deployments"
  ADD COLUMN "build_id" UUID,
  ADD COLUMN "promoted_from_id" UUID,
  ADD COLUMN "health_status" TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_organization_id_build_id_fkey"
  FOREIGN KEY ("organization_id", "build_id") REFERENCES "agent_builds"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 新規テーブルにも既存と同じ tenant isolation を適用する。
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['connectors', 'agent_connection_links', 'agent_environment_configs', 'agent_builds'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())',
      t
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE connectors, agent_connection_links, agent_environment_configs, agent_builds TO agent_studio_app;
