import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDb, DEFAULT_DATABASE_URL } from "./db.js";

const DEV_TOKEN = "local-factoring-token";

function log(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, time: new Date().toISOString(), service: "demo-factoring-api", msg: message, ...fields }));
}

function main(): void {
  const production = process.env.NODE_ENV === "production";
  const raw = process.env.FACTORING_API_TOKEN?.trim();
  let token = raw && raw !== "unset" ? raw : undefined;
  if (!token) {
    if (production) {
      log("error", "FACTORING_API_TOKEN が設定されていないため起動できません");
      process.exit(1);
    }
    token = DEV_TOKEN;
    log("warn", `FACTORING_API_TOKEN が未設定のため、開発用のトークン "${DEV_TOKEN}" を使います`);
  }

  const connectionString = process.env.FACTORING_DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;
  const db = createDb(connectionString);
  const port = Number(process.env.PORT ?? 8091);
  const server = serve({ fetch: createApp({ token, db, log: (msg, f) => log("info", msg, f) }).fetch, port, hostname: "0.0.0.0" });
  log("info", "ファクタリング基幹システムモックを起動しました", { port });

  const shutdown = () => server.close(() => void db.close().finally(() => process.exit(0)));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main();
