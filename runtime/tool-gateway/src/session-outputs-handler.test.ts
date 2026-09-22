import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import type { SessionGrant } from "@agent-studio/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";
import { createSessionOutputsHandler, SESSION_OUTPUTS_PREFIX } from "./session-outputs-handler.js";
import { sessionOutputsToken } from "./session-outputs.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const grant: SessionGrant = {
  session_id: SESSION_ID,
  run_id: "10000000-0000-4000-8000-000000000001",
  token_hash: "a".repeat(64),
  allowed_tools: [],
  policies: [],
  expires_at: "2099-01-01T00:00:00.000Z",
};
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function start() {
  const controller = {
    getGrantBySessionId: vi.fn(async (id: string) => (id === SESSION_ID ? grant : null)),
    storeSessionArtifact: vi.fn(async () => ({
      run_artifact_id: "60000000-0000-4000-8000-000000000001",
      path: "generated_images/dog.png",
      scan_status: "passed" as const,
      retained_until: "2099-01-01T00:00:00.000Z",
    })),
  };
  const handler = createSessionOutputsHandler({ controller, logger: createLogger("silent") });
  const server = createServer((req, res) => void handler(req, res, (req.url ?? "/").split("?")[0] ?? "/"));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${SESSION_OUTPUTS_PREFIX}`;
  return { controller, base };
}

describe("作業領域の成果物の受け口", () => {
  it("Session専用tokenが一致するときだけ、hashを確かめて保存する", async () => {
    const { controller, base } = await start();
    const body = Buffer.from("png-bytes");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const token = sessionOutputsToken(SESSION_ID, grant.token_hash);

    const ok = await fetch(`${base}${SESSION_ID}/generated_images/dog.png`, {
      method: "PUT", headers: { authorization: `Bearer ${token}`, "x-content-sha256": sha256 }, body,
    });
    expect(ok.status).toBe(200);
    expect(controller.storeSessionArtifact).toHaveBeenCalledWith(SESSION_ID, {
      source: "session_output", path: "generated_images/dog.png", sha256, size_bytes: body.byteLength, content_base64: body.toString("base64"),
    });

    const wrongToken = await fetch(`${base}${SESSION_ID}/generated_images/dog.png`, { method: "PUT", headers: { authorization: "Bearer forged" }, body });
    expect(wrongToken.status).toBe(401);
    const otherSession = await fetch(`${base}20000000-0000-4000-8000-000000000001/outputs/a.txt`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body });
    expect(otherSession.status).toBe(401);
    const tampered = await fetch(`${base}${SESSION_ID}/outputs/a.txt`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "x-content-sha256": "0".repeat(64) }, body });
    expect(tampered.status).toBe(400);
    expect(controller.storeSessionArtifact).toHaveBeenCalledTimes(1);
  });

  it("回収対象外のディレクトリと親ディレクトリ参照は受け付けない", async () => {
    const { controller, base } = await start();
    const token = sessionOutputsToken(SESSION_ID, grant.token_hash);
    for (const path of ["repo/.env", "outputs/%2E%2E/secret", "outputs/.hidden", "outputs"]) {
      const res = await fetch(`${base}${SESSION_ID}/${path}`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: "x" });
      expect(res.status, path).toBe(400);
    }
    expect(controller.getGrantBySessionId).not.toHaveBeenCalled();
  });
});

it("Runtime Controllerと同じtokenを計算する", () => {
  expect(sessionOutputsToken(SESSION_ID, "a".repeat(64))).toBe("fSrTmQ4MHvoj75IS3F1mw_OMwmr_pMgblsenx16N1fg");
});
