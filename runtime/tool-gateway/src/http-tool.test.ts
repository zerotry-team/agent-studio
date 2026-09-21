import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { runtimeHttpToolSchema, type RuntimeHttpTool } from "@agent-studio/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authHeader, buildHttpRequest, executeHttpTool, MAX_RESPONSE_BYTES, ToolInputError } from "./http-tool.js";
import { EnvConnectionSecrets, SecretsManagerConnectionSecrets, SecretUnavailableError } from "./secrets.js";

const tool = (http: Record<string, unknown>): RuntimeHttpTool =>
  runtimeHttpToolSchema.parse({
    name: "t",
    description: "テスト",
    risk: "read",
    input_schema: { type: "object" },
    http,
  });

describe("buildHttpRequest", () => {
  it("URL の {param} を encodeURIComponent して埋め込み、残りをクエリにする（GET）", () => {
    const req = buildHttpRequest(tool({ method: "GET", url: "https://api.internal/products/{product_id}?lang=ja" }), {
      product_id: "a/b c?",
      include: ["stock", "price"],
      limit: 5,
      active: true,
      skip: null,
      missing: undefined,
    });
    expect(req.method).toBe("GET");
    const url = new URL(req.url);
    expect(url.pathname).toBe("/products/a%2Fb%20c%3F");
    expect([...url.searchParams.entries()]).toEqual([
      ["lang", "ja"],
      ["include", '["stock","price"]'],
      ["limit", "5"],
      ["active", "true"],
    ]);
    expect(req.body).toBeUndefined();
  });

  it("POST は残りの引数を JSON 本文にする", () => {
    const req = buildHttpRequest(
      tool({ method: "POST", url: "https://api.internal/products/{product_id}/price", headers: { "x-source": "agent-studio" } }),
      { product_id: "P-001", price_change: -400, note: { by: "agent" } },
    );
    expect(req.url).toBe("https://api.internal/products/P-001/price");
    expect(JSON.parse(req.body!)).toEqual({ price_change: -400, note: { by: "agent" } });
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["x-source"]).toBe("agent-studio");
  });

  it("DELETE もクエリ文字列にする", () => {
    const req = buildHttpRequest(tool({ method: "DELETE", url: "https://api.internal/items/{id}" }), { id: 7, force: true });
    expect(req.url).toBe("https://api.internal/items/7?force=true");
    expect(req.body).toBeUndefined();
  });

  it("URL に必要な引数が無ければ ToolInputError", () => {
    expect(() => buildHttpRequest(tool({ method: "GET", url: "https://api.internal/products/{product_id}" }), {})).toThrow(
      ToolInputError,
    );
  });

  it("引数でホストは変えられない", () => {
    const req = buildHttpRequest(tool({ method: "GET", url: "https://api.internal/products/{id}" }), { id: "../../evil.example/x" });
    expect(new URL(req.url).host).toBe("api.internal");
  });
});

describe("authHeader", () => {
  it("bearer / header / basic", () => {
    expect(authHeader({ type: "bearer", secret: "s" }, "tok\n")).toEqual(["authorization", "Bearer tok"]);
    expect(authHeader({ type: "header", header_name: "X-Api-Key", secret: "s" }, "k")).toEqual(["x-api-key", "k"]);
    expect(authHeader({ type: "basic", secret: "s" }, JSON.stringify({ username: "u", password: "p:w" }))).toEqual([
      "authorization",
      `Basic ${Buffer.from("u:p:w").toString("base64")}`,
    ]);
    expect(authHeader({ type: "none" }, "")).toBeNull();
  });

  it("basic の値が JSON でなければ、値を出さずにエラーにする", () => {
    let message = "";
    try {
      authHeader({ type: "basic", secret: "s" }, "user:super-secret");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain("super-secret");
    expect(message).toContain("認証情報");
  });
});

describe("executeHttpTool（ローカルの HTTP サーバーに対して）", () => {
  let server: Server;
  let base = "";
  const received: Array<{ method?: string; url?: string; headers: IncomingMessage["headers"]; body: string }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (req.url?.startsWith("/big")) {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("あ".repeat(MAX_RESPONSE_BYTES)); // 3 バイト文字 × 100K
          return;
        }
        if (req.url?.startsWith("/fail")) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "商品が見つかりません" }));
          return;
        }
        if (req.url?.startsWith("/slow")) {
          setTimeout(() => res.end("late"), 1_000);
          return;
        }
        if (req.url?.startsWith("/redirect")) {
          res.writeHead(302, { location: "http://evil.example/steal" });
          res.end();
          return;
        }
        if (req.url?.startsWith("/contract")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ contract_id: "123", customer_name: "田中太郎", bank_account: "secret", status: "active", updated_at: "2026-09-22" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    return new Promise<void>((r) => server.close(() => r()));
  });

  const secrets = { get: vi.fn(async (name: string) => (name === "demo-internal-api" ? "demo-token" : Promise.reject(new SecretUnavailableError(name)))) };

  it("認証情報を注入して実行する（Agent には渡らない）", async () => {
    const t = tool({ method: "POST", url: `${base}/products/{product_id}/price`, auth: { type: "bearer", secret: "demo-internal-api" } });
    const out = await executeHttpTool(t, { product_id: "P-001", price_change: -400 }, { secrets, userAgent: "ua-test" });
    expect(out.result.isError).toBeUndefined();
    expect(out.result.content).toEqual([{ type: "text", text: '{"ok":true}' }]);
    const last = received.at(-1)!;
    expect(last.method).toBe("POST");
    expect(last.url).toBe("/products/P-001/price");
    expect(last.headers.authorization).toBe("Bearer demo-token");
    expect(last.headers["user-agent"]).toBe("ua-test");
    expect(JSON.parse(last.body)).toEqual({ price_change: -400 });
  });

  it("2xx 以外は isError（ステータスと本文の一部）", async () => {
    const out = await executeHttpTool(tool({ method: "GET", url: `${base}/fail/{id}` }), { id: "X" }, { secrets });
    expect(out.result.isError).toBe(true);
    const text = (out.result.content[0] as { text: string }).text;
    expect(text).toContain("HTTP 404");
    expect(text).toContain("商品が見つかりません");
    expect(out.auditDetail).toBe("HTTP 404");
  });

  it("社内APIのRaw responseから許可fieldだけをモデルへ返す", async () => {
    const out = await executeHttpTool(
      tool({
        method: "GET",
        url: `${base}/contract`,
        output_schema: { type: "object", required: ["status"], properties: { status: { type: "string" } } },
        response_boundary: { allowed_fields: ["status", "updated_at"], max_bytes: 65536, max_records: 10 },
      }),
      {},
      { secrets },
    );
    expect(out.result.isError).toBeUndefined();
    expect((out.result.content[0] as { text: string }).text).toBe('{"status":"active","updated_at":"2026-09-22"}');
  });

  it("社内APIのエラー本文をモデルへ返さない", async () => {
    const out = await executeHttpTool(
      tool({
        method: "GET",
        url: `${base}/fail/{id}`,
        output_schema: { type: "object" },
        response_boundary: { allowed_fields: ["status"], max_bytes: 65536, max_records: 10 },
      }),
      { id: "X" },
      { secrets },
    );
    const text = (out.result.content[0] as { text: string }).text;
    expect(out.result.isError).toBe(true);
    expect(text).toContain("HTTP 404");
    expect(text).not.toContain("商品が見つかりません");
  });

  it("応答は 100KB で切り詰める", async () => {
    const out = await executeHttpTool(tool({ method: "GET", url: `${base}/big` }), {}, { secrets });
    const text = (out.result.content[0] as { text: string }).text;
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(MAX_RESPONSE_BYTES + 200);
    expect(text).toContain("切り詰めました");
  });

  it("タイムアウトは isError", async () => {
    const out = await executeHttpTool(tool({ method: "GET", url: `${base}/slow`, timeout_ms: 100 }), {}, { secrets });
    expect(out.result.isError).toBe(true);
    expect((out.result.content[0] as { text: string }).text).toContain("100 ミリ秒");
  });

  it("リダイレクトは追わない（認証情報を別ホストに送らない）", async () => {
    const out = await executeHttpTool(
      tool({ method: "GET", url: `${base}/redirect`, auth: { type: "bearer", secret: "demo-internal-api" } }),
      {},
      { secrets },
    );
    expect(out.result.isError).toBe(true);
    expect(out.auditDetail).toBe("HTTP 302");
  });

  it("認証情報が取れなければ SecretUnavailableError", async () => {
    const t = tool({ method: "GET", url: `${base}/x`, auth: { type: "bearer", secret: "unknown" } });
    await expect(executeHttpTool(t, {}, { secrets })).rejects.toBeInstanceOf(SecretUnavailableError);
  });
});

describe("ConnectionSecretProvider", () => {
  it("Secrets Manager の値を 5 分キャッシュする", async () => {
    let now = 0;
    const send = vi.fn(async (cmd: unknown) => {
      expect(cmd).toBeInstanceOf(GetSecretValueCommand);
      return { SecretString: `v-${send.mock.calls.length}` };
    });
    const provider = new SecretsManagerConnectionSecrets({ send } as never, "agent-studio/runtime/a/prod/connections/", 300_000, () => now);
    expect(await provider.get("demo-internal-api")).toBe("v-1");
    expect(await provider.get("demo-internal-api")).toBe("v-1");
    expect((send.mock.calls[0]![0] as GetSecretValueCommand).input.SecretId).toBe("agent-studio/runtime/a/prod/connections/demo-internal-api");
    now = 300_001;
    expect(await provider.get("demo-internal-api")).toBe("v-2");
  });

  it("env: CONNECTION_SECRET_<UPPER_SNAKE_NAME>", async () => {
    expect(EnvConnectionSecrets.variableName("demo-internal-api")).toBe("CONNECTION_SECRET_DEMO_INTERNAL_API");
    const provider = new EnvConnectionSecrets({ CONNECTION_SECRET_DEMO_INTERNAL_API: "tok" });
    expect(await provider.get("demo-internal-api")).toBe("tok");
    await expect(provider.get("other")).rejects.toBeInstanceOf(SecretUnavailableError);
  });
});
