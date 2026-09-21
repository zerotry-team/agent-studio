-- Align the Builder tables created by the preceding migrations with Prisma's
-- default referential action and identifier naming.

ALTER TABLE "builder_adapter_packages"
  DROP CONSTRAINT "builder_adapter_packages_organization_id_change_set_id_fkey",
  DROP CONSTRAINT "builder_adapter_packages_organization_id_fkey",
  DROP CONSTRAINT "builder_adapter_packages_organization_id_project_id_fkey",
  DROP CONSTRAINT "builder_adapter_packages_organization_id_runtime_id_fkey";
ALTER TABLE "builder_change_sets"
  DROP CONSTRAINT "builder_change_sets_organization_id_fkey",
  DROP CONSTRAINT "builder_change_sets_organization_id_project_id_fkey";
ALTER TABLE "builder_discovery_sources"
  DROP CONSTRAINT "builder_discovery_sources_organization_id_fkey",
  DROP CONSTRAINT "builder_discovery_sources_organization_id_project_id_fkey";
ALTER TABLE "builder_projects" DROP CONSTRAINT "builder_projects_organization_id_fkey";
ALTER TABLE "builder_releases"
  DROP CONSTRAINT "builder_releases_organization_id_agent_id_fkey",
  DROP CONSTRAINT "builder_releases_organization_id_build_id_fkey",
  DROP CONSTRAINT "builder_releases_organization_id_builder_run_id_fkey",
  DROP CONSTRAINT "builder_releases_organization_id_fkey",
  DROP CONSTRAINT "builder_releases_organization_id_preview_deployment_id_fkey",
  DROP CONSTRAINT "builder_releases_organization_id_preview_run_id_fkey",
  DROP CONSTRAINT "builder_releases_organization_id_project_id_fkey";
ALTER TABLE "builder_runs"
  DROP CONSTRAINT "builder_runs_organization_id_fkey",
  DROP CONSTRAINT "builder_runs_organization_id_project_id_fkey";
ALTER TABLE "builder_steps"
  DROP CONSTRAINT "builder_steps_organization_id_fkey",
  DROP CONSTRAINT "builder_steps_organization_id_run_id_fkey";
ALTER TABLE "builder_validation_runs"
  DROP CONSTRAINT "builder_validation_runs_organization_id_fkey",
  DROP CONSTRAINT "builder_validation_runs_organization_id_project_id_fkey";
ALTER TABLE "builder_workspace_sessions"
  DROP CONSTRAINT "builder_workspace_sessions_organization_id_change_set_id_fkey",
  DROP CONSTRAINT "builder_workspace_sessions_organization_id_fkey",
  DROP CONSTRAINT "builder_workspace_sessions_organization_id_project_id_fkey",
  DROP CONSTRAINT "builder_workspace_sessions_organization_id_runtime_id_fkey";
ALTER TABLE "capability_gaps"
  DROP CONSTRAINT "capability_gaps_organization_id_fkey",
  DROP CONSTRAINT "capability_gaps_organization_id_project_id_fkey";
ALTER TABLE "capability_plans"
  DROP CONSTRAINT "capability_plans_organization_id_fkey",
  DROP CONSTRAINT "capability_plans_organization_id_project_id_fkey";
ALTER TABLE "git_webhook_deliveries" DROP CONSTRAINT "git_webhook_deliveries_organization_id_fkey";
ALTER TABLE "human_actions"
  DROP CONSTRAINT "human_actions_organization_id_fkey",
  DROP CONSTRAINT "human_actions_organization_id_project_id_fkey";

ALTER TABLE "builder_projects" ADD CONSTRAINT "builder_projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "builder_runs"
  ADD CONSTRAINT "builder_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "builder_runs_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "builder_projects"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "builder_steps"
  ADD CONSTRAINT "builder_steps_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "builder_steps_organization_id_run_id_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "builder_runs"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "capability_plans"
  ADD CONSTRAINT "capability_plans_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "capability_plans_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "builder_projects"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "capability_gaps"
  ADD CONSTRAINT "capability_gaps_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "capability_gaps_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "builder_projects"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "human_actions"
  ADD CONSTRAINT "human_actions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "human_actions_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "builder_projects"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "builder_discovery_sources"
  ADD CONSTRAINT "builder_discovery_sources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "builder_discovery_sources_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "builder_projects"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "builder_change_sets"
  ADD CONSTRAINT "builder_change_sets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "builder_change_sets_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "builder_projects"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "builder_adapter_packages"
  ADD CONSTRAINT "builder_adapter_packages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "builder_adapter_packages_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "builder_projects"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "builder_adapter_packages_organization_id_change_set_id_fkey" FOREIGN KEY ("organization_id", "change_set_id") REFERENCES "builder_change_sets"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "builder_adapter_packages_organization_id_runtime_id_fkey" FOREIGN KEY ("organization_id", "runtime_id") REFERENCES "runtimes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "git_webhook_deliveries" ADD CONSTRAINT "git_webhook_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "builder_workspace_sessions"
  ADD CONSTRAINT "builder_workspace_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "builder_workspace_sessions_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "builder_projects"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "builder_workspace_sessions_organization_id_change_set_id_fkey" FOREIGN KEY ("organization_id", "change_set_id") REFERENCES "builder_change_sets"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "builder_workspace_sessions_organization_id_runtime_id_fkey" FOREIGN KEY ("organization_id", "runtime_id") REFERENCES "runtimes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "builder_validation_runs"
  ADD CONSTRAINT "builder_validation_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "builder_validation_runs_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "builder_projects"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "builder_releases"
  ADD CONSTRAINT "builder_releases_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "builder_releases_organization_id_project_id_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "builder_projects"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "builder_releases_organization_id_builder_run_id_fkey" FOREIGN KEY ("organization_id", "builder_run_id") REFERENCES "builder_runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "builder_releases_organization_id_agent_id_fkey" FOREIGN KEY ("organization_id", "agent_id") REFERENCES "agents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "builder_releases_organization_id_build_id_fkey" FOREIGN KEY ("organization_id", "build_id") REFERENCES "agent_builds"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "builder_releases_organization_id_preview_deployment_id_fkey" FOREIGN KEY ("organization_id", "preview_deployment_id") REFERENCES "deployments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "builder_releases_organization_id_preview_run_id_fkey" FOREIGN KEY ("organization_id", "preview_run_id") REFERENCES "runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER INDEX "builder_adapter_packages_organization_id_connector_key_image_di"
  RENAME TO "builder_adapter_packages_organization_id_connector_key_imag_key";
