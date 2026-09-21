CREATE TABLE "worker_heartbeats" (
  "worker_id" TEXT NOT NULL,
  "version" TEXT,
  "active_runs" INTEGER NOT NULL DEFAULT 0,
  "active_sessions" INTEGER NOT NULL DEFAULT 0,
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("worker_id")
);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "worker_heartbeats" TO agent_studio_app;
