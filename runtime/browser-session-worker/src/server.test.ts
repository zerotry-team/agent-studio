import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserServer } from "./server.js";
import type { BrowserSession } from "./session.js";

const servers: ReturnType<typeof createBrowserServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("Browser Worker human relay API", () => {
  it("session tokenで隔離し、人間入力とProfile import/exportをBrowser内だけで扱う", async () => {
    const keyboardType = vi.fn(async () => undefined);
    const imported = vi.fn(async () => undefined);
    const session = {
      config: { sessionToken: "token-0123456789abcdef", mode: "authenticated_restricted" },
      page: () => ({
        screenshot: vi.fn(async () => Buffer.from("jpeg")),
        url: () => "https://example.com/login",
        title: vi.fn(async () => "Login"),
        mouse: { click: vi.fn(async () => undefined), wheel: vi.fn(async () => undefined) },
        keyboard: { type: keyboardType, press: vi.fn(async () => undefined) },
      }),
      navigateForHuman: vi.fn(async () => undefined),
      importStorageState: imported,
      exportStorageState: vi.fn(async () => ({ cookies: [{ name: "session", value: "secret", domain: "example.com" }], origins: [] })),
    } as unknown as BrowserSession;
    const server = createBrowserServer(session, "test");
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/human/token-0123456789abcdef`;

    expect((await fetch(`http://127.0.0.1:${port}/human/wrong/screenshot`)).status).toBe(404);
    const typed = await fetch(`${base}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "type", value: "human-only-password" }) });
    expect(typed.status).toBe(200);
    expect(keyboardType).toHaveBeenCalledWith("human-only-password");

    const state = { cookies: [], origins: [{ origin: "https://example.com", localStorage: [] }] };
    expect((await fetch(`${base}/profile`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(state) })).status).toBe(204);
    expect(imported).toHaveBeenCalledWith(state);
    const exported = await (await fetch(`${base}/profile`)).json();
    expect(exported).toEqual({ cookies: [{ name: "session", value: "secret", domain: "example.com" }], origins: [] });
  });

  it("Download本文はsession tokenが一致するときだけTool Gatewayへ返す", async () => {
    const body = Buffer.from("id,total\n1,100\n");
    const session = {
      config: { sessionToken: "token-0123456789abcdef", mode: "public_ephemeral" },
      artifactBody: vi.fn((id: string) => (id === "artifact-1" ? { body, sha256: "f".repeat(64) } : undefined)),
    } as unknown as BrowserSession;
    const server = createBrowserServer(session, "test");
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;

    const ok = await fetch(`http://127.0.0.1:${port}/artifacts/token-0123456789abcdef/artifact-1`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-artifact-sha256")).toBe("f".repeat(64));
    expect(Buffer.from(await ok.arrayBuffer()).equals(body)).toBe(true);
    expect((await fetch(`http://127.0.0.1:${port}/artifacts/wrong-token/artifact-1`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/artifacts/token-0123456789abcdef/missing`)).status).toBe(404);
  });
});
