import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { createBrowserServer } from "./server.js";
import { BrowserSession } from "./session.js";

function version(): string {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const config = loadConfig();
const session = new BrowserSession(config);
await session.start();
const server = createBrowserServer(session, version());
server.requestTimeout = 5 * 60_000;
server.listen(config.port, "0.0.0.0", () => {
  console.log(JSON.stringify({ level: "info", message: "Browser Session Worker started", port: config.port, mode: config.mode, version: version() }));
});

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", message: "Browser Session Worker stopping", signal }));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await session.close();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
