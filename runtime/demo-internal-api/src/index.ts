import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const DEV_TOKEN = "local-demo-token";

function log(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}): void {
  // CloudWatch Logs で読みやすいよう 1 行の JSON にする
  console.log(JSON.stringify({ level, time: new Date().toISOString(), service: "demo-internal-api", msg: message, ...fields }));
}

function main(): void {
  const production = process.env.NODE_ENV === "production";
  const raw = process.env.DEMO_API_TOKEN?.trim();
  let token = raw && raw !== "unset" ? raw : undefined;
  if (!token) {
    if (production) {
      log("error", "DEMO_API_TOKEN が設定されていないため起動できません（Secrets Manager の値を確認してください）");
      process.exit(1);
    }
    token = DEV_TOKEN;
    log("warn", `DEMO_API_TOKEN が未設定のため、開発用のトークン "${DEV_TOKEN}" を使います`);
  }

  const port = Number(process.env.PORT ?? 8090);
  const server = serve({ fetch: createApp({ token, log: (msg, f) => log("info", msg, f) }).fetch, port, hostname: "0.0.0.0" });
  log("info", "社内 API モックを起動しました", { port });

  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main();
