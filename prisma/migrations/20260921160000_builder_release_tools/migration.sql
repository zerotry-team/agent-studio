ALTER TABLE "builder_releases"
  ADD COLUMN "required_tools" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
