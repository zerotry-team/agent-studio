ALTER TABLE "runtimes"
ADD COLUMN "capabilities" JSONB NOT NULL DEFAULT '[]';
