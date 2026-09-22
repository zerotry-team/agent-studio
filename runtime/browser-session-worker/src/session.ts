import { createHash, randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Download, type Page, type Route } from "playwright-core";
import type { BrowserWorkerConfig } from "./config.js";
import { assertUrlAllowed } from "./policy.js";

export class BrowserSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private current?: Page;
  private actions = 0;
  private readonly artifacts = new Map<string, BrowserArtifact>();

  constructor(readonly config: BrowserWorkerConfig) {}

  async start(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: ["--disable-quic", "--no-sandbox"],
      ...(this.config.proxyServer ? { proxy: { server: this.config.proxyServer } } : {}),
    });
    this.context = await this.browser.newContext({
      viewport: this.config.viewport,
      deviceScaleFactor: 1,
      locale: this.config.locale,
      timezoneId: this.config.timezone,
      acceptDownloads: true,
    });
    await this.context.route("**/*", (route) => this.enforceRoute(route));
    this.context.on("page", (page) => {
      this.current = page;
      page.setDefaultTimeout(this.config.actionTimeoutMs);
    });
    this.current = await this.context.newPage();
    this.current.setDefaultTimeout(this.config.actionTimeoutMs);
  }

  /**
   * Runtime Controller が顧客Runtime内のProfile Storeから取得したstorage stateを、
   * private network越しに一度だけ復元する。Control PlaneやTool resultへ本文は返さない。
   */
  async importStorageState(state: { cookies?: unknown[]; origins?: unknown[] }): Promise<void> {
    const context = this.browserContext();
    if (context.pages().some((page) => page.url() !== "about:blank")) {
      throw new Error("Browser操作開始後はProfileを復元できません");
    }
    const cookies = Array.isArray(state.cookies) ? state.cookies : [];
    const origins = Array.isArray(state.origins) ? state.origins : [];
    if (cookies.length > 500 || origins.length > 100) throw new Error("Browser Profileが上限を超えています");

    for (const raw of cookies) {
      if (!raw || typeof raw !== "object") throw new Error("Browser Profileのcookie形式が正しくありません");
      const cookie = raw as Record<string, unknown>;
      const domain = typeof cookie.domain === "string" ? cookie.domain.replace(/^\./, "").toLowerCase() : "";
      if (!this.config.allowedDomains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`))) {
        throw new Error("Browser Profileに許可外ドメインのcookieが含まれています");
      }
    }
    for (const raw of origins) {
      if (!raw || typeof raw !== "object" || typeof (raw as { origin?: unknown }).origin !== "string") {
        throw new Error("Browser Profileのorigin形式が正しくありません");
      }
      assertUrlAllowed((raw as { origin: string }).origin, this.config.allowedDomains, false);
    }

    if (cookies.length) await context.addCookies(cookies as Parameters<BrowserContext["addCookies"]>[0]);
    for (const raw of origins as Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }>) {
      const page = await context.newPage();
      await page.goto(raw.origin, { waitUntil: "domcontentloaded" });
      const entries = Array.isArray(raw.localStorage) ? raw.localStorage.slice(0, 1000) : [];
      await page.evaluate((items) => {
        localStorage.clear();
        for (const item of items) localStorage.setItem(item.name, item.value);
      }, entries);
      await page.close();
    }
  }

  async exportStorageState(): Promise<{ cookies: unknown[]; origins: unknown[] }> {
    const state = await this.browserContext().storageState();
    return { cookies: state.cookies, origins: state.origins };
  }

  async navigateForHuman(url: string): Promise<void> {
    const allowed = assertUrlAllowed(url, this.config.allowedDomains, false);
    await this.page().goto(allowed.toString(), { waitUntil: "domcontentloaded" });
  }

  async saveDownload(download: Download): Promise<BrowserArtifactMetadata> {
    const failure = await download.failure();
    if (failure) throw new Error(`Downloadに失敗しました: ${failure}`);
    const stream = await download.createReadStream();
    if (!stream) throw new Error("Download本文を取得できませんでした");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const raw of stream) {
      const chunk = Buffer.from(raw);
      size += chunk.byteLength;
      if (size > MAX_ARTIFACT_BYTES) {
        stream.destroy();
        throw new Error(`Downloadは${MAX_ARTIFACT_BYTES / 1024 / 1024}MB以下にしてください`);
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    const filename = safeFilename(download.suggestedFilename());
    const inspected = inspectArtifact(filename, body);
    if (inspected.scan_status !== "passed") throw new Error("安全検査で拒否されたDownloadです");
    const artifact: BrowserArtifact = {
      artifact_id: randomUUID(),
      filename,
      mime_type: inspected.mime_type,
      size_bytes: body.byteLength,
      sha256: inspected.sha256,
      scan_status: inspected.scan_status,
      retained_until: new Date(Date.now() + ARTIFACT_TTL_MS).toISOString(),
      body,
    };
    this.artifacts.set(artifact.artifact_id, artifact);
    return metadata(artifact);
  }

  artifactForUpload(input: { artifactId: string; filename: string; sha256: string }): BrowserArtifact {
    this.sweepArtifacts();
    const artifact = this.artifacts.get(input.artifactId);
    if (!artifact) throw new Error("このRunのArtifactが見つからないか、保持期限が切れています");
    if (artifact.filename !== input.filename || artifact.sha256 !== input.sha256) {
      throw new Error("Artifactのファイル名またはhashがDownload時の値と一致しません");
    }
    return artifact;
  }

  artifactBody(artifactId: string): BrowserArtifact | undefined {
    this.sweepArtifacts();
    return this.artifacts.get(artifactId);
  }

  private sweepArtifacts(): void {
    const now = Date.now();
    for (const [id, artifact] of this.artifacts) {
      if (Date.parse(artifact.retained_until) <= now) this.artifacts.delete(id);
    }
  }

  private async enforceRoute(route: Route): Promise<void> {
    try {
      const requested = route.request().url();
      if (!requested.startsWith("data:") && !requested.startsWith("blob:")) {
        assertUrlAllowed(requested, this.config.allowedDomains, this.config.allowPublicWeb);
      }
      await route.continue();
    } catch {
      await route.abort("blockedbyclient");
    }
  }

  countAction(): void {
    this.actions++;
    if (this.actions > this.config.maxActions) throw new Error(`Browser Session の最大操作数（${this.config.maxActions}）を超えました`);
  }

  page(): Page {
    if (!this.current) throw new Error("Browser Session が起動していません");
    return this.current;
  }

  browserContext(): BrowserContext {
    if (!this.context) throw new Error("Browser Session が起動していません");
    return this.context;
  }

  selectPage(index: number): Page {
    const page = this.browserContext().pages()[index];
    if (!page) throw new Error(`タブ ${index} はありません`);
    this.current = page;
    return page;
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.current = undefined;
    this.context = undefined;
    this.browser = undefined;
    this.artifacts.clear();
  }
}

const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const ARTIFACT_TTL_MS = 30 * 60_000;

export interface BrowserArtifactMetadata {
  artifact_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  scan_status: "passed";
  retained_until: string;
}

export interface BrowserArtifact extends BrowserArtifactMetadata {
  body: Buffer;
}

function safeFilename(input: string): string {
  const filename = input.replace(/\\/g, "/").split("/").pop()?.replace(/[\0\r\n]/g, "").trim();
  if (!filename || filename === "." || filename === "..") throw new Error("Downloadファイル名が不正です");
  return filename.slice(0, 255);
}

function inspectArtifact(filename: string, body: Buffer): { sha256: string; mime_type: string; scan_status: "passed" | "rejected" } {
  const executable = body.subarray(0, 2).toString("ascii") === "MZ"
    || body.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const eicar = body.toString("latin1").includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE");
  let mimeType = "application/octet-stream";
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) mimeType = "image/png";
  else if (body.subarray(0, 4).toString("ascii") === "%PDF") mimeType = "application/pdf";
  else if (body[0] === 0xff && body[1] === 0xd8) mimeType = "image/jpeg";
  else {
    const extension = filename.split(".").pop()?.toLowerCase();
    mimeType = ({ csv: "text/csv", json: "application/json", md: "text/markdown", txt: "text/plain", webp: "image/webp" } as Record<string, string>)[extension ?? ""] ?? mimeType;
  }
  return {
    sha256: createHash("sha256").update(body).digest("hex"),
    mime_type: mimeType,
    scan_status: executable || eicar ? "rejected" : "passed",
  };
}

function metadata(artifact: BrowserArtifact): BrowserArtifactMetadata {
  const { body: _body, ...value } = artifact;
  return value;
}
