import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { GitWebhookService } from "../application/git-webhooks.js";
import { AppError } from "../domain/errors.js";
import type { AppEnv } from "./middleware.js";

export function createWebhookRoutes(git: GitWebhookService) {
  const app = new Hono<AppEnv>();
  app.use("*", bodyLimit({ maxSize: 1024 * 1024, onError: () => { throw new AppError("payload_too_large", 400, "Webhook payloadが大きすぎます"); } }));
  app.post("/github", async (c) => c.json(await git.handle({
    delivery: c.req.header("x-github-delivery") ?? null,
    event: c.req.header("x-github-event") ?? null,
    signature: c.req.header("x-hub-signature-256") ?? null,
  }, await c.req.text()), 202));
  return app;
}
