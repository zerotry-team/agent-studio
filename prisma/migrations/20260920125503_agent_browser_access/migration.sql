-- DropForeignKey
ALTER TABLE "agent_schedules" DROP CONSTRAINT "agent_schedules_organization_id_agent_id_fkey";

-- DropForeignKey
ALTER TABLE "agent_schedules" DROP CONSTRAINT "agent_schedules_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "external_jobs" DROP CONSTRAINT "external_jobs_organization_id_connector_id_fkey";

-- DropForeignKey
ALTER TABLE "external_jobs" DROP CONSTRAINT "external_jobs_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "external_jobs" DROP CONSTRAINT "external_jobs_organization_id_run_id_fkey";

-- DropIndex
DROP INDEX "connections_status_expires_at_idx";

-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "browser_access" TEXT NOT NULL DEFAULT 'restricted',
ADD COLUMN     "browser_allowed_domains" JSONB NOT NULL DEFAULT '[]';

-- AddForeignKey
ALTER TABLE "external_jobs" ADD CONSTRAINT "external_jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_jobs" ADD CONSTRAINT "external_jobs_organization_id_run_id_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "runs"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_jobs" ADD CONSTRAINT "external_jobs_organization_id_connector_id_fkey" FOREIGN KEY ("organization_id", "connector_id") REFERENCES "connectors"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_organization_id_agent_id_fkey" FOREIGN KEY ("organization_id", "agent_id") REFERENCES "agents"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
