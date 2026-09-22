import { request, Agent } from "node:http";
import { describe, expect, it } from "vitest";
import { CALLBACK_PORT } from "./config.js";
import { waitForCallback } from "./browser.js";

// ブラウザと同じく接続を使い回すクライアントで送る
const agent = new Agent({ keepAlive: true });
const get = (path: string) => new Promise<number>((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port: CALLBACK_PORT, path, agent }, (res) => {
    res.resume();
    res.on("end", () => resolve(res.statusCode ?? 0));
  });
  req.on("error", reject);
  req.end();
});

describe("waitForCallback", () => {
  it("続けて待ち受けても、前の待ち受けの接続に次の戻りが届かない", async () => {
    const first = waitForCallback(["/github/callback"]);
    await new Promise((r) => setTimeout(r, 50));
    expect(await get("/github/callback?code=a")).toBe(200);
    expect((await first).query.get("code")).toBe("a");

    const second = waitForCallback(["/github/setup"]);
    await new Promise((r) => setTimeout(r, 50));
    expect(await get("/github/setup?installation_id=1")).toBe(200);
    expect((await second).query.get("installation_id")).toBe("1");
    agent.destroy();
  });
});
