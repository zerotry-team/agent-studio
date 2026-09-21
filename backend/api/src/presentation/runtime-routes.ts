import {
  approvalRequestSchema,
  auditBatchRequestSchema,
  heartbeatRequestSchema,
  jobResultRequestSchema,
  registerRequestSchema,
  sessionEventRequestSchema,
  tokenRequestSchema,
} from "@agent-studio/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { RuntimeApiService } from "../application/runtime-api.js";
import { AppError } from "../domain/errors.js";
import { requireRuntime, type AppEnv } from "./middleware.js";

const uuid = z.uuid();

/**
 * Runtime Controller 向け API（/runtime/v1）。パスは contracts の RUNTIME_API と一致させる。
 * register / token 以外は Runtime のアクセストークンが必要。
 */
export function createRuntimeRoutes(service: RuntimeApiService) {
  const app = new Hono<AppEnv>();
  app.use("*", bodyLimit({ maxSize: 512 * 1024, onError: () => { throw new AppError("payload_too_large", 400, "送信内容が大きすぎます"); } }));

  app.post("/register", async (c) => c.json(await service.register(registerRequestSchema.parse(await c.req.json()), c.get("sourceIp"))));
  app.post("/token", async (c) => c.json(await service.token(tokenRequestSchema.parse(await c.req.json()))));

  const authed = new Hono<AppEnv>();
  authed.use("*", requireRuntime(service));

  authed.post("/heartbeat", async (c) => c.json(await service.heartbeat(c.get("runtime"), heartbeatRequestSchema.parse(await c.req.json()))));
  authed.get("/jobs/next", async (c) => {
    const wait = z.coerce.number().int().min(0).max(25).default(20).parse(c.req.query("wait"));
    return c.json({ job: await service.nextJob(c.get("runtime"), wait, c.req.raw.signal) });
  });
  authed.post("/jobs/:id/result", async (c) => {
    await service.jobResult(c.get("runtime"), uuid.parse(c.req.param("id")), jobResultRequestSchema.parse(await c.req.json()));
    return c.body(null, 204);
  });
  authed.post("/jobs/:id/git-credential", async (c) =>
    c.json(await service.gitCredential(c.get("runtime"), uuid.parse(c.req.param("id")))),
  );
  authed.post("/sessions/:id/events", async (c) => {
    await service.sessionEvent(c.get("runtime"), uuid.parse(c.req.param("id")), sessionEventRequestSchema.parse(await c.req.json()));
    return c.body(null, 204);
  });
  authed.get("/sessions/active", async (c) => c.json({ sessions: await service.activeSessions(c.get("runtime")) }));
  authed.post("/approvals", async (c) => c.json(await service.createApproval(c.get("runtime"), approvalRequestSchema.parse(await c.req.json()))));
  authed.get("/approvals/:id", async (c) => c.json(await service.getApproval(c.get("runtime"), uuid.parse(c.req.param("id")))));
  authed.post("/approvals/:id/consume", async (c) => c.json(await service.consumeApproval(c.get("runtime"), uuid.parse(c.req.param("id")))));
  authed.post("/audit", async (c) => {
    await service.audit(c.get("runtime"), auditBatchRequestSchema.parse(await c.req.json()).events);
    return c.body(null, 204);
  });
  authed.get("/environment-key", async (c) => c.json(await service.environmentKey(c.get("runtime"))));

  app.route("/", authed);
  return app;
}
