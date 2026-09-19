import { GetSecretValueCommand, PutSecretValueCommand, ResourceNotFoundException } from "@aws-sdk/client-secrets-manager";
import { RUNTIME_API } from "@agent-studio/contracts";
import { describe, expect, it, vi } from "vitest";
import { createDevIdentitySigner } from "./identity.js";
import { createLogger } from "./logger.js";
import { ControllerSecrets, SecretsManagerStore } from "./secrets.js";
import {
  AgentStudioClient,
  RegistrationFailedError,
  RuntimeAuth,
  RuntimeNotRegisteredError,
  RuntimeRevokedError,
  StudioHttp,
  type FetchLike,
} from "./studio-client.js";

const logger = createLogger("silent");
const BASE = "https://studio.example.com";
const RUNTIME_ID = "30000000-0000-4000-8000-000000000001";
const ORG_ID = "40000000-0000-4000-8000-000000000001";
const BOOTSTRAP_SECRET = "agent-studio/runtime/sample-a/prod/bootstrap-token";
const ENV_KEY_SECRET = "agent-studio/runtime/sample-a/prod/openai-environment-key";
const BOOTSTRAP_TOKEN = "bt_".padEnd(48, "x");

type Handler = (body: unknown, headers: Record<string, string>) => { status: number; json?: unknown };

/** パスごとの応答を順に返す fetch のモック */
function fakeFetch(routes: Record<string, Handler[]>) {
  const calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const path = url.pathname;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path, body, headers });
    const queue = routes[path];
    const handler = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
    if (!handler) return new Response("not found", { status: 404 });
    const { status, json } = handler(body, headers);
    return new Response(json === undefined ? null : JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

/** Secrets Manager クライアントのモック */
function fakeSecretsManager(initial: Record<string, string | undefined>) {
  const values = new Map(Object.entries(initial));
  const writes: Array<{ id: string; value: string }> = [];
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof GetSecretValueCommand) {
      const v = values.get(cmd.input.SecretId!);
      if (v === undefined) throw new ResourceNotFoundException({ message: "not found", $metadata: {} });
      return { SecretString: v };
    }
    if (cmd instanceof PutSecretValueCommand) {
      writes.push({ id: cmd.input.SecretId!, value: cmd.input.SecretString! });
      values.set(cmd.input.SecretId!, cmd.input.SecretString!);
      return {};
    }
    throw new Error("unexpected command");
  });
  return { client: { send } as never, writes, values };
}

function setup(routes: Record<string, Handler[]>, secretValues: Record<string, string | undefined>, now = () => 0) {
  const { fetchImpl, calls } = fakeFetch(routes);
  const sm = fakeSecretsManager(secretValues);
  const secrets = new ControllerSecrets(
    new SecretsManagerStore(sm.client),
    { bootstrapTokenSecretId: BOOTSTRAP_SECRET, environmentKeySecretId: ENV_KEY_SECRET },
    logger,
  );
  const http = new StudioHttp(BASE, "test", fetchImpl);
  const auth = new RuntimeAuth({
    http,
    signIdentity: createDevIdentitySigner("123456789012", "as-sample-a-prod-runtime"),
    secrets,
    controllerVersion: "0.1.0",
    logger,
    now,
  });
  return { auth, http, calls, sm };
}

const notRegistered: Handler = () => ({ status: 403, json: { error: { code: "runtime_not_registered", message: "未登録です" } } });
const tokenOk =
  (token: string, expiresIn = 900): Handler =>
  () => ({ status: 200, json: { runtime_id: RUNTIME_ID, organization_id: ORG_ID, access_token: token, expires_in: expiresIn } });

describe("RuntimeAuth: 登録フロー", () => {
  it("未登録なら Bootstrap Token で登録し、環境キーを保存して Bootstrap Token を consumed にする", async () => {
    const { auth, calls, sm } = setup(
      {
        [RUNTIME_API.token]: [notRegistered],
        [RUNTIME_API.register]: [
          () => ({
            status: 200,
            json: {
              runtime_id: RUNTIME_ID,
              organization_id: ORG_ID,
              stage: "production",
              access_token: "at-1",
              expires_in: 900,
              environment_key: "ek-secret-value",
            },
          }),
        ],
      },
      { [BOOTSTRAP_SECRET]: BOOTSTRAP_TOKEN },
    );

    expect(await auth.getAccessToken()).toBe("at-1");
    expect(auth.state).toBe("active");
    expect(auth.runtimeId).toBe(RUNTIME_ID);

    expect(calls.map((c) => c.path)).toEqual([RUNTIME_API.token, RUNTIME_API.register]);
    const register = calls[1]!;
    expect(register.body).toMatchObject({
      bootstrap_token: BOOTSTRAP_TOKEN,
      controller_version: "0.1.0",
      identity: { method: "POST", url: "dev://123456789012/as-sample-a-prod-runtime" },
    });
    // 登録・トークン取得には Authorization を付けない
    expect(register.headers.authorization).toBeUndefined();

    // 環境キーを保存してから Bootstrap Token を消す
    expect(sm.writes).toEqual([
      { id: ENV_KEY_SECRET, value: "ek-secret-value" },
      { id: BOOTSTRAP_SECRET, value: "consumed" },
    ]);
  });

  it("Bootstrap Token が無い（unset）なら登録せずに待つ", async () => {
    const { auth, calls, sm } = setup({ [RUNTIME_API.token]: [notRegistered] }, { [BOOTSTRAP_SECRET]: "unset" });
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(RuntimeNotRegisteredError);
    expect(auth.state).toBe("waiting_bootstrap");
    expect(calls.map((c) => c.path)).toEqual([RUNTIME_API.token]);
    expect(sm.writes).toEqual([]);
  });

  it("シークレットに値が無い・consumed でも登録しない", async () => {
    for (const value of [undefined, "consumed", ""]) {
      const { auth } = setup({ [RUNTIME_API.token]: [notRegistered] }, { [BOOTSTRAP_SECRET]: value });
      await expect(auth.getAccessToken()).rejects.toBeInstanceOf(RuntimeNotRegisteredError);
    }
  });

  it("登録が拒否されたら RegistrationFailedError（Bootstrap Token は消さない）", async () => {
    const { auth, sm } = setup(
      {
        [RUNTIME_API.token]: [notRegistered],
        [RUNTIME_API.register]: [() => ({ status: 401, json: { error: { code: "invalid_identity", message: "AWS の身元を確認できません" } } })],
      },
      { [BOOTSTRAP_SECRET]: BOOTSTRAP_TOKEN },
    );
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(RegistrationFailedError);
    expect(auth.state).toBe("registration_failed");
    expect(sm.writes).toEqual([]);
  });

  it("失効していれば RuntimeRevokedError", async () => {
    const { auth } = setup(
      { [RUNTIME_API.token]: [() => ({ status: 403, json: { error: { code: "runtime_revoked", message: "失効しています" } } })] },
      {},
    );
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(RuntimeRevokedError);
    expect(auth.state).toBe("revoked");
  });
});

describe("RuntimeAuth: トークンの再利用と更新", () => {
  it("期限の 2 分前まではキャッシュし、それ以降は取り直す", async () => {
    let now = 0;
    const { auth, calls } = setup({ [RUNTIME_API.token]: [tokenOk("at-1"), tokenOk("at-2")] }, {}, () => now);
    expect(await auth.getAccessToken()).toBe("at-1");
    now = (900 - 121) * 1000;
    expect(await auth.getAccessToken()).toBe("at-1");
    now = (900 - 119) * 1000;
    expect(await auth.getAccessToken()).toBe("at-2");
    expect(calls.filter((c) => c.path === RUNTIME_API.token)).toHaveLength(2);
  });

  it("同時に呼ばれても token の取得は 1 回", async () => {
    const { auth, calls } = setup({ [RUNTIME_API.token]: [tokenOk("at-1")] }, {});
    await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
    expect(calls).toHaveLength(1);
  });
});

describe("AgentStudioClient", () => {
  it("401 なら一度だけトークンを取り直して再試行する", async () => {
    const { auth, http, calls } = setup(
      {
        [RUNTIME_API.token]: [tokenOk("at-1"), tokenOk("at-2")],
        [RUNTIME_API.activeSessions]: [
          () => ({ status: 401, json: { error: { code: "unauthorized", message: "期限切れ" } } }),
          (_b, headers) => ({ status: 200, json: { sessions: [], seen: headers.authorization } }),
        ],
      },
      {},
    );
    const client = new AgentStudioClient(http, auth);
    expect(await client.activeSessions()).toEqual([]);
    const sessionCalls = calls.filter((c) => c.path === RUNTIME_API.activeSessions);
    expect(sessionCalls.map((c) => c.headers.authorization)).toEqual(["Bearer at-1", "Bearer at-2"]);
  });

  it("403 runtime_revoked で失効状態になる", async () => {
    const { auth, http } = setup(
      {
        [RUNTIME_API.token]: [tokenOk("at-1")],
        [RUNTIME_API.heartbeat]: [() => ({ status: 403, json: { error: { code: "runtime_revoked", message: "失効" } } })],
      },
      {},
    );
    const client = new AgentStudioClient(http, auth);
    await expect(
      client.heartbeat({ controller_version: "0.1.0", gateway_url: "http://gateway.local:8080/mcp", active_sessions: [], tools: [] }),
    ).rejects.toBeInstanceOf(RuntimeRevokedError);
    expect(auth.state).toBe("revoked");
  });

  it("解釈できないジョブは job_id を読んで invalid として返す", async () => {
    const jobId = "20000000-0000-4000-8000-000000000001";
    const { auth, http } = setup(
      {
        [RUNTIME_API.token]: [tokenOk("at-1")],
        [RUNTIME_API.nextJob]: [() => ({ status: 200, json: { job: { type: "future_job", job_id: jobId } } })],
      },
      {},
    );
    const next = await new AgentStudioClient(http, auth).nextJob(20);
    expect(next).toMatchObject({ kind: "invalid", jobId });
  });
});
