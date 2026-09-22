import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../app.js";
import { buildDeps, buildServices } from "../container.js";
import { loadEnv } from "../env.js";
import { createDatabase } from "../infrastructure/db/prisma.js";
import { MemorySecretStore } from "../infrastructure/secrets/secret-store.js";
import { MemoryObjectStore } from "../infrastructure/storage/object-store.js";
import { createLogger } from "../logger.js";
import { WorkerScheduler } from "../worker/scheduler.js";
import { StudioFunctionExecutor } from "../worker/studio-functions.js";
import type { Deps } from "../application/deps.js";

/**
 * 結合テスト用の環境。アプリ（Hono）と Worker を同じプロセスで動かし、OpenAI は擬似実装を使う。
 * DB は DATABASE_URL（アプリ用ロール）/ DIRECT_URL（所有者: テストデータの準備用）。
 */
export function createHarness(overrides: Partial<Deps> = {}, envOverrides: NodeJS.ProcessEnv = {}) {
  const env = loadEnv({
    ...process.env,
    NODE_ENV: "test",
    AUTH_MODE: "dev",
    SECRETS_MODE: "memory",
    AGENTS_API_MODE: "fake",
    RUNTIME_IDENTITY_MODE: "dev",
    RUNTIME_SERVER_ID: "agent-studio-test",
    OPENAI_DEFAULT_MODEL: "test-model",
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
    WORKER_ID: `test-${randomUUID()}`,
    AGENT_TURN_START_TIMEOUT_SECONDS: "1",
    AGENT_TURN_MAX_RECOVERIES: "1",
    ARTIFACTS_BUCKET: "test-artifacts",
    AUDIT_EXPORT_BUCKET: "test-audit",
    ...envOverrides,
  });
  const logger = createLogger(env.LOG_LEVEL, "test");
  const database = createDatabase(env);
  const objects = new MemoryObjectStore();
  const deps = buildDeps(env, logger, database, { secrets: new MemorySecretStore(), objects, ...overrides });
  const app = createApp(deps, buildServices(deps));
  const admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_URL! }) });

  const suffix = randomUUID().slice(0, 8);

  async function request(method: string, path: string, opts: { email?: string; org?: string; body?: unknown; token?: string } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    else if (opts.email) headers.authorization = `Bearer dev:${opts.email}`;
    if (opts.org) headers["x-organization-id"] = opts.org;
    const res = await app.request(path, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
  }

  /** 組織・メンバーを所有者ロールで作る（RLS の外） */
  async function createOrg(name: string, members: { email: string; role: string; approver?: boolean }[]) {
    const org = await admin.organizations.create({ data: { slug: `${name}-${suffix}`, name, worker_pool: env.WORKER_ID } });
    await admin.organization_openai_settings.create({ data: { organization_id: org.id } });
    for (const m of members) {
      const user = await admin.users.upsert({
        where: { email: m.email },
        create: { email: m.email, auth_subject: `dev|${m.email}` },
        update: {},
      });
      await admin.organization_members.create({
        data: { organization_id: org.id, user_id: user.id, role: m.role, is_approver: m.approver ?? false },
      });
    }
    return org;
  }

  let workerAbort: AbortController | null = null;
  let workerDone: Promise<void> | null = null;
  function startWorker(functions: StudioFunctionExecutor = new StudioFunctionExecutor(deps.db, deps.secrets)) {
    workerAbort = new AbortController();
    const scheduler = new WorkerScheduler(deps, functions);
    workerDone = scheduler.run(workerAbort.signal);
  }

  async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await fn();
      if (ok(v)) return v;
      if (Date.now() > deadline) throw new Error(`timeout: ${JSON.stringify(v).slice(0, 500)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async function close() {
    workerAbort?.abort();
    await workerDone;
    await database.close();
    await admin.$disconnect();
  }

  return { env, deps, app, admin, objects, suffix, request, createOrg, startWorker, waitFor, close };
}

export type Harness = ReturnType<typeof createHarness>;
