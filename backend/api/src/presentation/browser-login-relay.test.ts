import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { Deps } from "../application/deps.js";
import type { RuntimeApiService } from "../application/runtime-api.js";
import { BrowserLoginRelay } from "./browser-login-relay.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const nextMessage = (socket: WebSocket) => new Promise<Record<string, unknown>>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("message timeout")), 2_000);
  socket.once("message", (raw) => { clearTimeout(timeout); resolve(JSON.parse(raw.toString()) as Record<string, unknown>); });
});

const opened = (socket: WebSocket) => new Promise<void>((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});

describe("BrowserLoginRelay", () => {
  it("one-time user ticketとRuntime tokenを同じsessionでpairし、frameを保存せず転送する", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const consume = vi.fn(async (_sessionId: string, hash: string) => hash === createHash("sha256").update("user-ticket").digest("hex") ? { expires_at: expiresAt } : null);
    const findFirst = vi.fn(async () => ({ status: "running", expires_at: expiresAt }));
    const deps = {
      system: { consumeBrowserLoginTicket: consume },
      db: { org: async (_organizationId: string, callback: (tx: unknown) => unknown) => callback({ browser_login_sessions: { findFirst } }) },
    } as unknown as Deps;
    const runtimeApi = { authenticate: vi.fn(async () => ({ organizationId: "org-1", runtimeId: "runtime-1" })) } as unknown as RuntimeApiService;
    const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
    servers.push(server);
    new BrowserLoginRelay(deps, runtimeApi).attach(server as never);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/relay/v1/browser-login`;
    const user = new WebSocket(url);
    const runtime = new WebSocket(url);
    await Promise.all([opened(user), opened(runtime)]);

    user.send(JSON.stringify({ type: "auth", role: "user", session_id: "session-1", token: "user-ticket" }));
    expect((await nextMessage(user)).type).toBe("waiting");
    runtime.send(JSON.stringify({ type: "auth", role: "runtime", session_id: "session-1", token: "runtime-token" }));
    expect((await nextMessage(runtime)).type).toBe("paired");
    expect((await nextMessage(user)).type).toBe("paired");

    const forwarded = nextMessage(user);
    runtime.send(JSON.stringify({ type: "frame", image: "transient-image", url: "https://example.com", title: "Login" }));
    expect(await forwarded).toMatchObject({ type: "frame", image: "transient-image" });
    expect(consume).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledTimes(1);
    user.close(); runtime.close();
  });
});
