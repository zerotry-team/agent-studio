import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright-core";
import type { BrowserWorkerConfig } from "./config.js";
import { assertUrlAllowed } from "./policy.js";

export class BrowserSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private current?: Page;
  private actions = 0;

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

  private async enforceRoute(route: Route): Promise<void> {
    try {
      const requested = route.request().url();
      if (!requested.startsWith("data:") && !requested.startsWith("blob:")) {
        assertUrlAllowed(requested, this.config.allowedDomains);
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
  }
}
