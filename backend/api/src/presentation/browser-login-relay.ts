import { createHash } from "node:crypto";
import type { ServerType } from "@hono/node-server";
import type { Deps } from "../application/deps.js";
import type { RuntimeApiService } from "../application/runtime-api.js";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

const PATH = "/relay/v1/browser-login";
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

type Role = "user" | "runtime";
type AuthMessage = { type: "auth"; role: Role; session_id: string; token: string };
type Peer = { socket: WebSocket; role: Role; sessionId: string; expiresAt: number };

function parseAuth(raw: RawData): AuthMessage | null {
  try {
    const value = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (value.type !== "auth" || (value.role !== "user" && value.role !== "runtime")) return null;
    if (typeof value.session_id !== "string" || typeof value.token !== "string") return null;
    return { type: "auth", role: value.role, session_id: value.session_id, token: value.token };
  } catch {
    return null;
  }
}

/**
 * Human Loginの画面転送専用。フレーム本文はメモリにも保持せず、そのまま対向Peerへ転送する。
 * API/監査ログへpassword、MFA、Screenshot、cookieを書かない。
 */
export class BrowserLoginRelay {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  private readonly sessions = new Map<string, Partial<Record<Role, Peer>>>();

  constructor(
    private readonly deps: Deps,
    private readonly runtimeApi: RuntimeApiService,
  ) {}

  attach(server: ServerType): void {
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://relay.invalid");
      if (url.pathname !== PATH) return socket.destroy();
      this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
    });
  }

  private accept(socket: WebSocket): void {
    const timer = setTimeout(() => socket.close(4401, "authentication required"), 10_000);
    timer.unref();
    socket.once("message", (raw) => {
      clearTimeout(timer);
      const auth = parseAuth(raw);
      if (!auth) return socket.close(4400, "invalid authentication");
      void this.authenticate(socket, auth).catch(() => socket.close(4403, "authentication failed"));
    });
  }

  private async authenticate(socket: WebSocket, auth: AuthMessage): Promise<void> {
    const expiresAt = auth.role === "user"
      ? await this.authenticateUser(auth.session_id, auth.token)
      : await this.authenticateRuntime(auth.session_id, auth.token);
    if (expiresAt <= Date.now()) return socket.close(4408, "session expired");

    const peers = this.sessions.get(auth.session_id) ?? {};
    peers[auth.role]?.socket.close(4409, "replaced by a newer connection");
    const peer: Peer = { socket, role: auth.role, sessionId: auth.session_id, expiresAt };
    peers[auth.role] = peer;
    this.sessions.set(auth.session_id, peers);

    socket.on("message", (data, isBinary) => this.forward(peer, data, isBinary));
    socket.on("close", () => this.remove(peer));
    socket.on("error", () => this.remove(peer));
    socket.send(JSON.stringify({ type: peers.user && peers.runtime ? "paired" : "waiting", expires_at: new Date(expiresAt).toISOString() }));
    const other = peers[auth.role === "user" ? "runtime" : "user"];
    if (other && other.socket.readyState === 1) other.socket.send(JSON.stringify({ type: "paired", expires_at: new Date(Math.min(expiresAt, other.expiresAt)).toISOString() }));
  }

  private async authenticateUser(sessionId: string, token: string): Promise<number> {
    const consumed = await this.deps.system.consumeBrowserLoginTicket(sessionId, createHash("sha256").update(token).digest("hex"));
    if (!consumed) throw new Error("invalid ticket");
    return consumed.expires_at.getTime();
  }

  private async authenticateRuntime(sessionId: string, token: string): Promise<number> {
    const runtime = await this.runtimeApi.authenticate(token, null);
    return this.deps.db.org(runtime.organizationId, async (tx) => {
      const session = await tx.browser_login_sessions.findFirst({ where: { id: sessionId, runtime_id: runtime.runtimeId } });
      if (!session || !["pending", "running"].includes(session.status) || session.expires_at <= new Date()) throw new Error("invalid session");
      return session.expires_at.getTime();
    });
  }

  private forward(peer: Peer, data: RawData, isBinary: boolean): void {
    if (Date.now() >= peer.expiresAt) return peer.socket.close(4408, "session expired");
    const peers = this.sessions.get(peer.sessionId);
    const other = peers?.[peer.role === "user" ? "runtime" : "user"];
    if (!other || other.socket.readyState !== other.socket.OPEN) {
      peer.socket.send(JSON.stringify({ type: "waiting" }));
      return;
    }
    other.socket.send(data, { binary: isBinary });
  }

  private remove(peer: Peer): void {
    const peers = this.sessions.get(peer.sessionId);
    if (!peers || peers[peer.role] !== peer) return;
    delete peers[peer.role];
    const other = peers[peer.role === "user" ? "runtime" : "user"];
    if (other && other.socket.readyState === 1) other.socket.send(JSON.stringify({ type: "waiting" }));
    if (!peers.user && !peers.runtime) this.sessions.delete(peer.sessionId);
  }
}
