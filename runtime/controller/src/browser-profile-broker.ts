import type { BrowserLoginResult, RuntimeBrowserProfile, StartBrowserLoginJob } from "@agent-studio/contracts";
import { WebSocket } from "ws";
import type { BrowserLauncher } from "./browser-launcher.js";
import type { BrowserProfileStore } from "./browser-profile-store.js";
import type { Logger } from "./logger.js";
import type { RuntimeAuth } from "./studio-client.js";

const START_TIMEOUT_MS = 5 * 60_000;
const PROFILE_TTL_MS = 30 * 24 * 60 * 60_000;

type Frame = { image: string; url: string; title: string };
type UserMessage =
  | { type: "navigate"; url: string }
  | { type: "click"; x: number; y: number }
  | { type: "type"; value: string }
  | { type: "key"; key: string }
  | { type: "scroll"; delta_x: number; delta_y: number }
  | { type: "complete" }
  | { type: "cancel" };

function humanUrl(endpoint: string, token: string, suffix: string): string {
  const url = new URL(endpoint);
  url.pathname = `/human/${token}/${suffix}`;
  url.search = "";
  return url.toString();
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000), headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!response.ok) throw new Error(`Browser WorkerがHTTP ${response.status}を返しました`);
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

function isAllowedHost(hostname: string, domains: readonly string[]): boolean {
  const host = hostname.replace(/^\./, "").toLowerCase();
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`));
}

function validateStorageState(body: Buffer, domains: readonly string[]): void {
  const state = JSON.parse(body.toString("utf8")) as { cookies?: Array<{ domain?: unknown }>; origins?: Array<{ origin?: unknown }> };
  for (const cookie of state.cookies ?? []) {
    if (typeof cookie.domain !== "string" || !isAllowedHost(cookie.domain, domains)) throw new Error("許可外ドメインのcookieを保存しようとしました");
  }
  for (const origin of state.origins ?? []) {
    if (typeof origin.origin !== "string" || !isAllowedHost(new URL(origin.origin).hostname, domains)) throw new Error("許可外originを保存しようとしました");
  }
}

function parseUserMessage(raw: string): UserMessage | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    switch (value.type) {
      case "navigate": return typeof value.url === "string" ? { type: "navigate", url: value.url.slice(0, 2000) } : null;
      case "click": return typeof value.x === "number" && Number.isFinite(value.x) && typeof value.y === "number" && Number.isFinite(value.y) ? { type: "click", x: value.x, y: value.y } : null;
      case "type": return typeof value.value === "string" ? { type: "type", value: value.value.slice(0, 20_000) } : null;
      case "key": return typeof value.key === "string" ? { type: "key", key: value.key.slice(0, 100) } : null;
      case "scroll": return typeof value.delta_x === "number" && Number.isFinite(value.delta_x) && typeof value.delta_y === "number" && Number.isFinite(value.delta_y)
        ? { type: "scroll", delta_x: value.delta_x, delta_y: value.delta_y } : null;
      case "complete": return { type: "complete" };
      case "cancel": return { type: "cancel" };
      default: return null;
    }
  } catch {
    return null;
  }
}

export class BrowserProfileBroker {
  constructor(
    private readonly launcher: BrowserLauncher,
    private readonly store: BrowserProfileStore,
    private readonly auth: RuntimeAuth,
    private readonly agentStudioUrl: string,
    private readonly logger: Logger,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async startLogin(job: StartBrowserLoginJob): Promise<BrowserLoginResult> {
    if (this.store.kind === "disabled") throw new Error("Browser Profile Storeが有効になっていません");
    const launched = await this.launcher.launch({
      sessionId: job.login_session_id,
      runId: job.profile_id,
      idempotencyToken: job.job_id,
      config: {
        enabled: true,
        mode: "authenticated_restricted",
        profile_id: job.profile_id,
        allow_public_web: false,
        allowed_domains: job.allowed_domains,
        code_execution_enabled: false,
        computer_actions_enabled: false,
        viewport: { width: 1440, height: 900 },
      },
    });
    try {
      const endpoint = await this.waitForEndpoint(launched.taskArn, launched.accessToken, new Date(job.expires_at).getTime());
      const result = await this.relay(job, endpoint, launched.accessToken);
      return result;
    } finally {
      await this.launcher.stop(launched.taskArn, "Human Login Sessionを終了しました").catch(() => undefined);
    }
  }

  async restore(profile: RuntimeBrowserProfile, endpoint: string, accessToken: string, expectedDomains: readonly string[]): Promise<void> {
    if (new Date(profile.expires_at) <= new Date()) throw new Error("Browser Profileの有効期限が切れています");
    const expected = [...expectedDomains].sort();
    const actual = [...profile.allowed_domains].sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("Browser Profileの許可ドメインがBuildと一致しません");
    const body = await this.store.get(profile.runtime_object_key);
    validateStorageState(body, profile.allowed_domains);
    await requestJson<void>(humanUrl(endpoint, accessToken, "profile"), { method: "PUT", body });
  }

  async revoke(runtimeObjectKey: string): Promise<void> {
    await this.store.delete(runtimeObjectKey);
  }

  private async waitForEndpoint(taskArn: string, accessToken: string, expiresAt: number): Promise<string> {
    const deadline = Math.min(Date.now() + START_TIMEOUT_MS, expiresAt);
    while (Date.now() < deadline) {
      const state = (await this.launcher.describe([taskArn])).get(taskArn);
      if (state?.lastStatus === "RUNNING") {
        const endpoint = this.launcher.endpoint(state, accessToken);
        if (endpoint) return endpoint;
      }
      if (state?.lastStatus === "STOPPED" || !state) throw new Error("Human Login用Browser Workerが起動前に停止しました");
      await this.sleep(1000);
    }
    throw new Error("Human Login用Browser Workerの起動がタイムアウトしました");
  }

  private async relay(job: StartBrowserLoginJob, endpoint: string, accessToken: string): Promise<BrowserLoginResult> {
    const relay = new URL(this.agentStudioUrl);
    relay.protocol = relay.protocol === "https:" ? "wss:" : "ws:";
    relay.pathname = "/relay/v1/browser-login";
    relay.search = "";
    const expiresAt = new Date(job.expires_at).getTime();

    return await new Promise<BrowserLoginResult>((resolve, reject) => {
      let settled = false;
      let socket: WebSocket | undefined;
      let reconnectTimer: NodeJS.Timeout | undefined;
      let navigated = false;
      let queue = Promise.resolve();
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        socket?.close();
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new Error("Human Login Sessionの有効期限が切れました"))), Math.max(1, expiresAt - Date.now()));
      timer.unref();

      const sendFrame = async (frame?: Frame) => {
        const current = frame ?? await requestJson<Frame>(humanUrl(endpoint, accessToken, "screenshot"));
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "frame", ...current }));
      };
      const handle = async (message: UserMessage) => {
        if (message.type === "cancel") return finish(() => reject(new Error("利用者がHuman Loginを中止しました")));
        if (message.type === "complete") {
          const state = await requestJson<unknown>(humanUrl(endpoint, accessToken, "profile"));
          const body = Buffer.from(JSON.stringify(state));
          validateStorageState(body, job.allowed_domains);
          const stored = await this.store.put(job.profile_id, body);
          const profileExpiresAt = new Date(Date.now() + PROFILE_TTL_MS).toISOString();
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "completed" }));
          return finish(() => resolve({
            login_session_id: job.login_session_id,
            profile_id: job.profile_id,
            runtime_object_key: stored.key,
            verified_domains: [...job.allowed_domains],
            expires_at: profileExpiresAt,
          }));
        }
        const frame = await requestJson<Frame>(humanUrl(endpoint, accessToken, "action"), { method: "POST", body: JSON.stringify(message) });
        await sendFrame(frame);
      };

      const connect = async () => {
        if (settled || Date.now() >= expiresAt) return;
        const token = await this.auth.getAccessToken();
        const candidate = new WebSocket(relay);
        socket = candidate;
        candidate.on("open", () => candidate.send(JSON.stringify({ type: "auth", role: "runtime", session_id: job.login_session_id, token })));
        candidate.on("message", (raw) => {
          const text = raw.toString();
          let control: { type?: unknown } = {};
          try { control = JSON.parse(text) as { type?: unknown }; } catch { return; }
          if (control.type === "paired") {
            queue = queue.then(async () => {
              if (!navigated) {
                const frame = await requestJson<Frame>(humanUrl(endpoint, accessToken, "action"), {
                  method: "POST",
                  body: JSON.stringify({ type: "navigate", url: `https://${job.allowed_domains[0]}` }),
                });
                navigated = true;
                await sendFrame(frame);
              } else await sendFrame();
            }).catch((error) => {
              if (candidate.readyState === WebSocket.OPEN) candidate.send(JSON.stringify({ type: "error", message: "ログイン画面を開けませんでした" }));
              this.logger.warn({ error: error instanceof Error ? error.message : "unknown", login_session_id: job.login_session_id }, "Human Loginの初期画面を開けませんでした");
            });
            return;
          }
          const message = parseUserMessage(text);
          if (!message) return;
          queue = queue.then(() => handle(message)).catch((error) => {
            if (candidate.readyState === WebSocket.OPEN) candidate.send(JSON.stringify({ type: "error", message: "Browser操作に失敗しました" }));
            this.logger.warn({ error: error instanceof Error ? error.message : "unknown", login_session_id: job.login_session_id }, "Human LoginのBrowser操作に失敗しました");
          });
        });
        candidate.on("error", () => candidate.close());
        candidate.on("close", () => {
          if (settled || Date.now() >= expiresAt || socket !== candidate) return;
          this.logger.info({ login_session_id: job.login_session_id }, "Human Login Relayへ再接続します");
          reconnectTimer = setTimeout(() => void connect().catch(() => undefined), 1_000);
          reconnectTimer.unref();
        });
      };
      void connect().catch(() => finish(() => reject(new Error("Human Login Relayへ接続できませんでした"))));
    });
  }
}
