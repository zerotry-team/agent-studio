import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SESSION_ARTIFACT_MAX_BYTES, sessionOutputPathSchema } from "@agent-studio/contracts";
import type { ControllerApi } from "./controller-client.js";
import { ControllerError } from "./controller-client.js";
import type { Logger } from "./logger.js";
import { errorMessage } from "./logger.js";
import { sessionOutputsToken } from "./session-outputs.js";

export const SESSION_OUTPUTS_PREFIX = "/session-outputs/";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionOutputsDeps {
  controller: Pick<ControllerApi, "getGrantBySessionId" | "storeSessionArtifact">;
  logger: Logger;
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
 * Session Worker が作業領域（/workspace/outputs など）のファイルを送る口。
 * PUT /session-outputs/<session_id>/<workspace からの相対パス>、Authorization: Bearer <Session 専用 token>。
 * token は MCP の token とは別で、この Session の成果物の保存にしか使えない。
 */
export function createSessionOutputsHandler(deps: SessionOutputsDeps) {
  return async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    if (req.method !== "PUT") return send(res, 405, { error: "method_not_allowed" });
    const rest = path.slice(SESSION_OUTPUTS_PREFIX.length);
    const slash = rest.indexOf("/");
    const sessionId = slash > 0 ? rest.slice(0, slash) : "";
    let relative: string;
    try {
      relative = rest.slice(slash + 1).split("/").map((part) => decodeURIComponent(part)).join("/");
    } catch {
      return send(res, 400, { error: "invalid_path" });
    }
    if (!UUID_RE.test(sessionId) || !sessionOutputPathSchema.safeParse(relative).success) return send(res, 400, { error: "invalid_path" });

    const presented = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    let grant;
    try {
      grant = presented ? await deps.controller.getGrantBySessionId(sessionId) : null;
    } catch (err) {
      deps.logger.warn({ err: errorMessage(err) }, "成果物の送信元セッションを確認できません");
      return send(res, 503, { error: "controller_unavailable" });
    }
    const expected = grant ? Buffer.from(sessionOutputsToken(sessionId, grant.token_hash)) : null;
    const given = Buffer.from(presented ?? "");
    if (!expected || expected.byteLength !== given.byteLength || !timingSafeEqual(expected, given)) {
      req.resume();
      return send(res, 401, { error: "invalid_token" });
    }

    const body = await readRaw(req, SESSION_ARTIFACT_MAX_BYTES);
    if (!body) return send(res, 413, { error: "too_large" });
    const sha256 = createHash("sha256").update(body).digest("hex");
    const declared = req.headers["x-content-sha256"];
    if (typeof declared === "string" && declared.toLowerCase() !== sha256) return send(res, 400, { error: "hash_mismatch" });

    try {
      const stored = await deps.controller.storeSessionArtifact(sessionId, {
        source: "session_output",
        path: relative,
        sha256,
        size_bytes: body.byteLength,
        content_base64: body.toString("base64"),
      });
      deps.logger.info({ session_id: sessionId, path: stored.path, bytes: body.byteLength }, "作業領域の成果物を保存しました");
      return send(res, 200, stored);
    } catch (err) {
      const status = err instanceof ControllerError && err.status && err.status >= 400 && err.status < 500 ? err.status : 502;
      deps.logger.warn({ session_id: sessionId, err: errorMessage(err) }, "作業領域の成果物を保存できませんでした");
      return send(res, status, { error: err instanceof ControllerError ? err.code ?? "store_failed" : "store_failed" });
    }
  };
}
