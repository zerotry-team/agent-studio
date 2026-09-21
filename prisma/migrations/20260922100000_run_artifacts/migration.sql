CREATE TABLE "run_artifacts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "path" TEXT NOT NULL,
  "object_key" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "scan_status" TEXT NOT NULL DEFAULT 'pending',
  "scan_engine" TEXT,
  "source" TEXT NOT NULL,
  "retained_until" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "run_artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "run_artifacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "run_artifacts_organization_id_run_id_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "runs"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "run_artifacts_size_check" CHECK ("size_bytes" >= 0 AND "size_bytes" <= 52428800),
  CONSTRAINT "run_artifacts_sha_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "run_artifacts_scan_check" CHECK ("scan_status" IN ('pending', 'passed', 'rejected', 'failed'))
);
CREATE UNIQUE INDEX "run_artifacts_organization_id_run_id_path_key" ON "run_artifacts"("organization_id", "run_id", "path");
CREATE UNIQUE INDEX "run_artifacts_organization_id_id_key" ON "run_artifacts"("organization_id", "id");
CREATE INDEX "run_artifacts_run_id_scan_status_idx" ON "run_artifacts"("run_id", "scan_status");
CREATE INDEX "run_artifacts_retained_until_idx" ON "run_artifacts"("retained_until");

ALTER TABLE "run_artifacts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "run_artifacts"
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "run_artifacts" TO agent_studio_app;
