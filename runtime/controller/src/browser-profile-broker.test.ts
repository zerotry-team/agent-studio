import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserLauncher } from "./browser-launcher.js";
import { BrowserProfileBroker } from "./browser-profile-broker.js";
import type { BrowserProfileStore } from "./browser-profile-store.js";
import { createLogger } from "./logger.js";

afterEach(() => vi.unstubAllGlobals());

const launcher = { kind: "noop" } as BrowserLauncher;
const auth = { getAccessToken: vi.fn(async () => "runtime-token") } as never;
const profile = {
  profile_id: "00000000-0000-4000-8000-000000000001",
  runtime_object_key: "profiles/00000000-0000-4000-8000-000000000001/2099-01-01T00-00-00.000Z.json",
  allowed_domains: ["example.com"],
  expires_at: "2099-01-01T00:00:00.000Z",
};

describe("BrowserProfileBroker restore", () => {
  it("Runtime StoreからだけProfile本文を読み、private Browser Workerへ復元する", async () => {
    const body = Buffer.from(JSON.stringify({ cookies: [{ name: "session", value: "secret", domain: ".example.com" }], origins: [] }));
    const store = { kind: "memory", get: vi.fn(async () => body), put: vi.fn(), delete: vi.fn() } as unknown as BrowserProfileStore;
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const broker = new BrowserProfileBroker(launcher, store, auth, "https://studio.example.test", createLogger("silent"));

    await broker.restore(profile, "http://10.0.0.10:8931/mcp/session-token", "session-token", ["example.com"]);
    expect(store.get).toHaveBeenCalledWith(profile.runtime_object_key);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://10.0.0.10:8931/human/session-token/profile",
      expect.objectContaining({ method: "PUT", body }),
    );
  });

  it("BuildとProfileのdomain不一致、およびProfile内の許可外cookieをfail closedする", async () => {
    const store = { kind: "memory", get: vi.fn(async () => Buffer.from(JSON.stringify({ cookies: [{ domain: "evil.example" }], origins: [] }))), put: vi.fn(), delete: vi.fn() } as unknown as BrowserProfileStore;
    const broker = new BrowserProfileBroker(launcher, store, auth, "https://studio.example.test", createLogger("silent"));
    await expect(broker.restore(profile, "http://10.0.0.10:8931/mcp/token", "token", ["other.example"])).rejects.toThrow("一致しません");
    await expect(broker.restore(profile, "http://10.0.0.10:8931/mcp/token", "token", ["example.com"])).rejects.toThrow("許可外");
  });
});
