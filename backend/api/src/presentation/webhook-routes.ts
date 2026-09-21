import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { GitWebhookService } from "../application/git-webhooks.js";
import type { DeploymentTriggerService } from "../application/deployment-triggers.js";
import { AppError } from "../domain/errors.js";
import type { AppEnv } from "./middleware.js";

export function createWebhookRoutes(git: GitWebhookService, deployments: DeploymentTriggerService) {
  const app = new Hono<AppEnv>();
  app.use("*", bodyLimit({ maxSize: 1024 * 1024, onError: () => { throw new AppError("payload_too_large", 400, "Webhook payloadが大きすぎます"); } }));
  app.post("/github", async (c) => c.json(await git.handle({
    delivery: c.req.header("x-github-delivery") ?? null,
    event: c.req.header("x-github-event") ?? null,
    signature: c.req.header("x-hub-signature-256") ?? null,
  }, await c.req.text()), 202));
  app.post("/deployments/:id", async (c) => c.json(await deployments.triggerWithWebhook(
    c.req.param("id"),
    await c.req.text(),
    c.req.header("x-agent-studio-signature") ?? null,
    c.req.header("x-agent-studio-delivery") ?? null,
  ), 202));
  return app;
}
