import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ControllerApi } from "./controller-client.js";
import type { Logger } from "./logger.js";
import { errorMessage } from "./logger.js";
import { builderTransferToken } from "./builder-transfer.js";

export const BUILDER_TRANSFER_PREFIX = "/builder-workspaces/";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Controller 側の上限（bundle 50MB）に合わせる */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface BuilderTransferDeps {
  controller: Pick<ControllerApi, "getGrantBySessionId">;
  controllerInternalUrl: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.from(raw as Buffer);
    size += chunk.byteLength;
    if (size > limit) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * ECS の Builder Session Worker が作業領域を受け取り（GET input）、結果を返す（PUT result / bundle）口。
 * /builder-workspaces/<session_id>/<change_set_id>/<input|result|bundle>、Authorization: Bearer <Session・Change Set 専用 token>。
 * Git の資格情報は Worker に渡さない（clone と push は Controller が行う）。
 */
export function createBuilderTransferHandler(deps: BuilderTransferDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const [sessionId = "", changeSetId = "", name = "", ...extra] = path.slice(BUILDER_TRANSFER_PREFIX.length).split("/");
    if (!UUID_RE.test(sessionId) || !UUID_RE.test(changeSetId) || extra.length > 0 || !["input", "result", "bundle"].includes(name)) {
      req.resume();
      return send(res, 404, { error: "not_found" });
    }
    const expectedMethod = name === "input" ? "GET" : "PUT";
    if (req.method !== expectedMethod) {
      req.resume();
      return send(res, 405, { error: "method_not_allowed" });
    }

    const presented = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    let grant;
    try {
      grant = presented ? await deps.controller.getGrantBySessionId(sessionId) : null;
    } catch (err) {
      deps.logger.warn({ err: errorMessage(err) }, "Builder作業領域の送信元セッションを確認できません");
      req.resume();
      return send(res, 503, { error: "controller_unavailable" });
    }
    const expected = grant ? Buffer.from(builderTransferToken(sessionId, changeSetId, grant.token_hash)) : null;
    const given = Buffer.from(presented ?? "");
    if (!expected || expected.byteLength !== given.byteLength || !timingSafeEqual(expected, given)) {
      req.resume();
      return send(res, 401, { error: "invalid_token" });
    }

    const target = `${deps.controllerInternalUrl}/internal/builder-workspaces/${sessionId}/${changeSetId}/${name}`;
    try {
      if (name === "input") {
        const upstream = await fetchImpl(target, { signal: AbortSignal.timeout(120_000) });
        const body = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
          "cache-control": "no-store",
        });
        res.end(body);
        return;
      }
      const body = await readRaw(req, MAX_UPLOAD_BYTES);
      if (!body) return send(res, 413, { error: "too_large" });
      const upstream = await fetchImpl(target, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(120_000),
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(text);
    } catch (err) {
      deps.logger.warn({ session_id: sessionId, artifact: name, err: errorMessage(err) }, "Builder作業領域を中継できませんでした");
      if (!res.headersSent) send(res, 502, { error: "controller_unavailable" });
      else res.end();
    }
  };
}
