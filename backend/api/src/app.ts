import { Hono } from "hono";
import type { Deps } from "./application/deps.js";
import type { Services } from "./container.js";
import { createApiRoutes } from "./presentation/api-routes.js";
import { errorHandler, requestContext, type AppEnv } from "./presentation/middleware.js";
import { createRuntimeRoutes } from "./presentation/runtime-routes.js";
import { createWebhookRoutes } from "./presentation/webhook-routes.js";
import { createDeploymentTriggerRoutes } from "./presentation/deployment-trigger-routes.js";

export function createApp(deps: Deps, services: Services) {
  const app = new Hono<AppEnv>();
  app.use("*", requestContext);
  app.onError(errorHandler(deps));
  app.notFound((c) => c.json({ error: { code: "not_found", message: "API が見つかりません" } }, 404));

  app.get("/health", async (c) => {
    // DB に届くかも確認する（ALB のヘルスチェック）
    await deps.db.run({ organizationId: null, userId: null }, (tx) => tx.$queryRaw`SELECT 1`);
    return c.json({ ok: true, env: deps.env.APP_ENV });
  });
  app.get("/health/ready", async (c) => {
    await deps.db.run({ organizationId: null, userId: null }, (tx) => tx.$queryRaw`SELECT 1`);
    const checks = await deps.system.readinessSnapshot();
    const ready = checks.worker.healthy
      && checks.stale_runtimes === 0
      && checks.unhealthy_production_deployments === 0
      && checks.recent_failed_runtime_jobs === 0;
    return c.json({ ok: ready, env: deps.env.APP_ENV, checks }, ready ? 200 : 503);
  });

  app.route("/api/v1", createApiRoutes(deps, services));
  app.route("/runtime/v1", createRuntimeRoutes(services.runtimeApi));
  app.route("/triggers/v1", createDeploymentTriggerRoutes(services.deploymentTriggers));
  app.route("/webhooks", createWebhookRoutes(services.gitWebhooks, services.deploymentTriggers));
  return app;
}
