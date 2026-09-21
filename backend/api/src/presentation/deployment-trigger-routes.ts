import { deploymentTriggerInputSchema } from "@agent-studio/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { DeploymentTriggerService } from "../application/deployment-triggers.js";
import { AppError } from "../domain/errors.js";
import type { AppEnv } from "./middleware.js";

const uuid = z.uuid();

export function createDeploymentTriggerRoutes(service: DeploymentTriggerService) {
  const app = new Hono<AppEnv>();
  app.use("*", bodyLimit({ maxSize: 128 * 1024, onError: () => { throw new AppError("payload_too_large", 400, "Trigger payloadが大きすぎます"); } }));
  app.post("/deployments/:id/runs", async (c) => {
    const auth = c.req.header("authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
    const input = deploymentTriggerInputSchema.parse(await c.req.json());
    return c.json(await service.triggerWithApiKey(token, uuid.parse(c.req.param("id")), input.input), 202);
  });
  return app;
}
