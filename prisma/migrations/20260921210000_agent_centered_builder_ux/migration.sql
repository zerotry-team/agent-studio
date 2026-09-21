ALTER TABLE "builder_projects"
ADD COLUMN "agent_id" UUID;

-- 既にPreview Releaseまで到達した作成作業は、そのReleaseのAgentへ復帰させる。
UPDATE "builder_projects" AS project
SET "agent_id" = (
  SELECT "agent_id"
  FROM "builder_releases"
  WHERE "organization_id" = project."organization_id"
    AND "project_id" = project."id"
  ORDER BY "created_at" DESC
  LIMIT 1
)
WHERE project."agent_id" IS NULL
  AND EXISTS (
    SELECT 1 FROM "builder_releases"
    WHERE "organization_id" = project."organization_id"
      AND "project_id" = project."id"
  );

ALTER TABLE "builder_projects"
ADD CONSTRAINT "builder_projects_organization_id_agent_id_fkey"
FOREIGN KEY ("organization_id", "agent_id")
REFERENCES "agents"("organization_id", "id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

CREATE INDEX "builder_projects_organization_id_agent_id_updated_at_idx"
ON "builder_projects"("organization_id", "agent_id", "updated_at" DESC);
