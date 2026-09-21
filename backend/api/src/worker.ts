import { buildDeps } from "./container.js";
import { loadEnv } from "./env.js";
import { createDatabase } from "./infrastructure/db/prisma.js";
import { createLogger } from "./logger.js";
import { WorkerScheduler } from "./worker/scheduler.js";
import { StudioFunctionExecutor } from "./worker/studio-functions.js";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL, "agent-studio-worker");
const database = createDatabase(env);
const deps = buildDeps(env, logger, database);
const scheduler = new WorkerScheduler(deps, new StudioFunctionExecutor(deps.db, deps.secrets, env, deps.objects));

const controller = new AbortController();
const stop = (signal: string) => {
  logger.info({ signal }, "Worker を停止します");
  controller.abort();
  setTimeout(() => process.exit(1), 30_000).unref();
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

logger.info({ worker_id: env.WORKER_ID, agents_api: env.AGENTS_API_MODE }, "Worker を起動しました");
await scheduler.run(controller.signal);
await database.close();
logger.info("Worker を停止しました");
process.exit(0);
