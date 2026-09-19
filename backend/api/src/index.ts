import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { buildDeps, buildServices } from "./container.js";
import { loadEnv } from "./env.js";
import { createDatabase } from "./infrastructure/db/prisma.js";
import { createLogger } from "./logger.js";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL, "agent-studio-api");
const database = createDatabase(env);
const deps = buildDeps(env, logger, database);
const app = createApp(deps, buildServices(deps));

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: "0.0.0.0" }, (info) => {
  logger.info({ port: info.port, app_env: env.APP_ENV, auth_mode: env.AUTH_MODE, agents_api: env.AGENTS_API_MODE }, "API を起動しました");
});

const shutdown = (signal: string) => {
  logger.info({ signal }, "API を停止します");
  server.close(() => {
    void database.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 20_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
