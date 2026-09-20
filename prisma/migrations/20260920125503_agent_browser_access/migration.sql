-- Browser access settings only; subsequent tables do not exist yet on a fresh database.
-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "browser_access" TEXT NOT NULL DEFAULT 'restricted',
ADD COLUMN     "browser_allowed_domains" JSONB NOT NULL DEFAULT '[]';
