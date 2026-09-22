import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runtimeToolConfigSchema } from "@agent-studio/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AdapterHost } from "./adapter-host.js";
import { ToolCatalog } from "./catalog.js";
import { executeHttpTool } from "./http-tool.js";
import { createLogger } from "./logger.js";

const logger = createLogger(process.env.TEST_LOG ?? "silent");
const dirs: string[] = [];
let host: AdapterHost | undefined;
afterEach(() => {
  host?.stopAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// 生成される Adapter と同じ形: 組み込みモジュールだけで POST /tools/<name> と GET /health を提供する
const BUNDLE = Buffer.from(`
import http from "node:http";
import { readFileSync } from "node:fs";
const server = http.createServer(async (req, res) => {
  if (req.url === "/health") { res.end("ok"); return; }
  if (req.method === "POST" && req.url === "/tools/list_low_stock_products") {
    let body = ""; for await (const c of req) body += c;
    const args = JSON.parse(body || "{}");
    let canReadOther = true;
    try { readFileSync("/etc/hosts"); } catch { canReadOther = false; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ threshold: args.threshold, base: process.env.DEMO_API_BASE_URL, token: process.env.DEMO_API_TOKEN === "secret-value", can_read_other_files: canReadOther }));
    return;
  }
  res.statusCode = 404; res.end();
});
server.listen(Number(process.env.PORT), "127.0.0.1");
`);
const digest = `sha256:${createHash("sha256").update(BUNDLE).digest("hex")}`;
const delivery = { connector_key: "sample-inventory", contract_hash: "a".repeat(64), image_digest: digest, source_commit: "c".repeat(40), package_signature: "s".repeat(88) };
const installed = {
  connector_key: "sample-inventory",
  descriptor: {
    version: 1,
    connector: { key: "sample-inventory", display_name: "在庫", description: "社内の在庫API" },
    tools: [{ name: "list_low_stock_products", description: "在庫の少ない商品", risk: "read", input_schema: { type: "object", properties: { threshold: { type: "integer" } } }, output_schema: {} }],
    execution: { kind: "http", health_endpoint: "/health" },
    network: { outbound_domains: [], private_network_required: true },
    required_connections: [],
    source: { repository: "example/adapters", merge_commit: "c".repeat(40), build_context: "adapters/sample-inventory" },
  },
  delivery,
  installed_at: new Date().toISOString(),
};

describe("AdapterHost", () => {
  it("Controller が保存した Adapter を permission model で起動し、Tool として公開する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "as-adapter-host-"));
    dirs.push(dir);
    const catalog = new ToolCatalog(runtimeToolConfigSchema.parse({ tools: [] }), async () => [], logger);
    const controllerFetch = (async (url: string) => {
      if (url.endsWith("/internal/adapters")) return Response.json([installed]);
      if (url.endsWith("/internal/adapters/sample-inventory/bundle")) return new Response(new Uint8Array(BUNDLE));
      return fetch(url);
    }) as unknown as typeof fetch;
    host = new AdapterHost({
      controllerInternalUrl: "http://controller.invalid",
      catalog,
      runtime: { env: { DEMO_API_BASE_URL: "http://internal.example" }, secrets: { DEMO_API_TOKEN: "demo-internal-api" } },
      secrets: { get: async (name: string) => (name === "demo-internal-api" ? "secret-value" : "") },
      logger,
      directory: dir,
      basePort: 18900 + Math.floor(Math.random() * 50),
      fetchImpl: controllerFetch,
    });
    await host.sync();
    const tool = catalog.get("list_low_stock_products");
    expect(tool?.delivery).toEqual(delivery);
    expect(catalog.entries().map((entry) => entry.name)).toContain("list_low_stock_products");
    if (tool?.target.kind !== "http") throw new Error("http tool expected");
    const outcome = await executeHttpTool(tool.target.tool, { threshold: 5 }, { secrets: { get: async () => "" } });
    const text = (outcome.result.content[0] as { text: string }).text;
    expect(JSON.parse(text)).toEqual({ threshold: 5, base: "http://internal.example", token: true, can_read_other_files: false });
  }, 30_000);
});
