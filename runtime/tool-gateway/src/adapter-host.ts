import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  redactLogText,
  adapterDescriptorSchema,
  runtimeHttpToolSchema,
  runtimeToolDeliverySchema,
  type AdapterRuntime,
} from "@agent-studio/contracts";
import { z } from "zod";
import type { CatalogTool, ToolCatalog } from "./catalog.js";
import type { Logger } from "./logger.js";
import { errorMessage } from "./logger.js";
import type { ConnectionSecretProvider } from "./secrets.js";

const installedAdapterSchema = z.object({
  connector_key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  descriptor: adapterDescriptorSchema,
  delivery: runtimeToolDeliverySchema,
  installed_at: z.string(),
});
type InstalledAdapter = z.infer<typeof installedAdapterSchema>;

export type SpawnAdapter = (file: string, env: NodeJS.ProcessEnv) => ChildProcess;

/**
 * Node の permission model で起動する（読めるのは bundle 自身だけ。子プロセス・worker・addon は使えない）。
 * 外への通信は Runtime の Security Group / DNS Firewall で絞る。
 */
export const defaultSpawnAdapter: SpawnAdapter = (file, env) =>
  spawn(process.execPath, ["--permission", `--allow-fs-read=${file}`, file], { env, stdio: ["ignore", "pipe", "pipe"] });

interface Running {
  digest: string;
  port: number;
  child: ChildProcess;
}

export interface AdapterHostDeps {
  controllerInternalUrl: string;
  catalog: Pick<ToolCatalog, "setAdapterTools" | "removeAdapterTools">;
  runtime: AdapterRuntime;
  secrets: ConnectionSecretProvider;
  logger: Logger;
  directory?: string;
  basePort?: number;
  fetchImpl?: typeof fetch;
  spawnAdapter?: SpawnAdapter;
  healthTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Adapter の HTTP 契約: POST /tools/<tool 名> に引数の JSON を送り、結果の JSON を受け取る */
export function adapterCatalogTools(adapter: InstalledAdapter, port: number): CatalogTool[] {
  return adapter.descriptor.tools.map((tool) => {
    const http = runtimeHttpToolSchema.parse({
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      reads_untrusted_content: false,
      input_schema: tool.input_schema,
      delivery: adapter.delivery,
      http: { method: "POST", url: `http://127.0.0.1:${port}/tools/${tool.name}`, auth: { type: "none" }, timeout_ms: 30_000 },
    });
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: http.input_schema,
      risk: tool.risk,
      readsUntrustedContent: false,
      delivery: adapter.delivery,
      policies: http.policies ?? [],
      target: { kind: "http", tool: http },
    } satisfies CatalogTool;
  });
}

/**
 * Runtime Controller が検証・保存した企業専用 Adapter を、この Tool Gateway の中で起動して Tool として公開する。
 * Adapter に渡すのは ツール設定の adapter_runtime にある値だけ。
 */
export class AdapterHost {
  private readonly running = new Map<string, Running>();
  private readonly ports = new Map<string, number>();
  private readonly directory: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private stopped = false;

  constructor(private readonly deps: AdapterHostDeps) {
    this.directory = deps.directory ?? "/tmp/agent-studio-adapters";
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private portFor(key: string): number {
    const existing = this.ports.get(key);
    if (existing) return existing;
    const port = (this.deps.basePort ?? 18100) + this.ports.size;
    this.ports.set(key, port);
    return port;
  }

  async sync(): Promise<void> {
    if (this.stopped) return;
    let adapters: InstalledAdapter[];
    try {
      const res = await this.fetchImpl(`${this.deps.controllerInternalUrl}/internal/adapters`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return;
      const json: unknown = await res.json();
      adapters = Array.isArray(json) ? json.flatMap((entry) => {
        const parsed = installedAdapterSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      }) : [];
    } catch (err) {
      this.deps.logger.debug({ err: errorMessage(err) }, "導入済みAdapterの一覧を取得できませんでした");
      return;
    }
    for (const adapter of adapters) {
      const current = this.running.get(adapter.connector_key);
      if (current && current.digest === adapter.delivery.image_digest && current.child.exitCode === null) continue;
      try {
        await this.start(adapter);
      } catch (err) {
        this.deps.logger.warn({ connector_key: adapter.connector_key, err: errorMessage(err) }, "企業専用Adapterを起動できませんでした");
      }
    }
  }

  private async adapterEnv(port: number): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      NODE_ENV: "production",
      PORT: String(port),
      HOST: "127.0.0.1",
      ...this.deps.runtime.env,
    };
    for (const [name, secret] of Object.entries(this.deps.runtime.secrets)) {
      env[name] = await this.deps.secrets.get(secret);
    }
    return env;
  }

  private async start(adapter: InstalledAdapter): Promise<void> {
    const key = adapter.connector_key;
    const res = await this.fetchImpl(`${this.deps.controllerInternalUrl}/internal/adapters/${key}/bundle`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Adapter packageを取得できませんでした（HTTP ${res.status}）`);
    const bundle = Buffer.from(await res.arrayBuffer());
    const digest = `sha256:${createHash("sha256").update(bundle).digest("hex")}`;
    if (digest !== adapter.delivery.image_digest) throw new Error("Adapter packageのdigestが導入時の値と一致しません");

    this.stop(key, "新しいAdapter packageへ切り替えます");
    const dir = join(this.directory, key);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // permission model は実体のパスで判定するため、symlink を解いておく
    const file = join(await realpath(dir), `${digest.slice(7, 23)}.mjs`);
    await writeFile(file, bundle, { mode: 0o400 });

    const port = this.portFor(key);
    const child = (this.deps.spawnAdapter ?? defaultSpawnAdapter)(file, await this.adapterEnv(port));
    const log = this.deps.logger.child({ connector_key: key });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    // Adapter の出力には業務データが混ざり得るため、長さだけ記録する
    child.stdout?.on("data", (chunk: string) => log.debug({ bytes: chunk.length }, "Adapterの標準出力"));
    let startupError = "";
    let started = false;
    child.stderr?.on("data", (chunk: string) => {
      // 起動前のエラーだけは原因の調査のために残す（起動後は業務データが混ざり得るので長さだけ）
      if (!started) startupError = `${startupError}${chunk}`.slice(-600);
      log.debug({ bytes: chunk.length }, "Adapterのエラー出力");
    });
    const entry: Running = { digest, port, child };
    this.running.set(key, entry);
    child.once("exit", (code, signal) => {
      if (this.running.get(key) !== entry) return;
      this.running.delete(key);
      this.deps.catalog.removeAdapterTools(key);
      log.warn({ code, signal }, "企業専用Adapterが停止しました（次の同期で起動し直します）");
    });

    const healthUrl = `http://127.0.0.1:${port}${adapter.descriptor.execution.health_endpoint}`;
    const deadline = Date.now() + (this.deps.healthTimeoutMs ?? 20_000);
    for (;;) {
      if (child.exitCode !== null) {
        const detail = redactLogText(startupError).replace(/\s+/g, " ").trim().slice(-300);
        throw new Error(`Adapterが起動直後に終了しました（終了コード ${child.exitCode}）${detail ? `: ${detail}` : ""}`);
      }
      try {
        const health = await this.fetchImpl(healthUrl, { signal: AbortSignal.timeout(2_000) });
        if (health.ok) break;
      } catch {
        // 起動待ち
      }
      if (Date.now() >= deadline) {
        this.stop(key, "health checkに応答しません");
        throw new Error("Adapterがhealth checkに応答しません");
      }
      await this.sleep(500);
    }
    started = true;
    this.deps.catalog.setAdapterTools(key, adapterCatalogTools(adapter, port));
    log.info({ port, image_digest: digest, tools: adapter.descriptor.tools.map((tool) => tool.name) }, "企業専用Adapterを起動しました");
  }

  stop(key: string, reason: string): void {
    const current = this.running.get(key);
    if (!current) return;
    this.running.delete(key);
    this.deps.catalog.removeAdapterTools(key);
    if (current.child.exitCode === null) current.child.kill("SIGTERM");
    this.deps.logger.info({ connector_key: key, reason }, "企業専用Adapterを停止しました");
  }

  stopAll(): void {
    this.stopped = true;
    for (const key of [...this.running.keys()]) this.stop(key, "Tool Gatewayを停止します");
  }
}
