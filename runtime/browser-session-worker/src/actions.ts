import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Locator } from "playwright-core";
import { executeRestrictedCode } from "./code-runtime.js";
import { assertUrlAllowed } from "./policy.js";
import type { BrowserSession } from "./session.js";

const object = (properties: Record<string, object>, required: string[] = []): Tool["inputSchema"] => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

export const BROWSER_TOOLS: Tool[] = [
  { name: "browser_navigate", description: "許可されたURLを開きます", inputSchema: object({ url: { type: "string" } }, ["url"]) },
  { name: "browser_snapshot", description: "現在ページのURL、title、アクセシビリティ表現を取得します", inputSchema: object({}) },
  { name: "browser_screenshot", description: "現在画面を元解像度のPNGで取得します", inputSchema: object({ full_page: { type: "boolean" } }) },
  { name: "browser_wait_for", description: "文字列、selector、または時間を待ちます", inputSchema: object({ text: { type: "string" }, selector: { type: "string" }, timeout_ms: { type: "number" } }) },
  { name: "browser_tabs", description: "タブを一覧・選択・閉じます", inputSchema: object({ action: { type: "string", enum: ["list", "select", "close"] }, index: { type: "number" } }, ["action"]) },
  { name: "browser_click", description: "要素をクリックします", inputSchema: object({ selector: { type: "string" }, text: { type: "string" } }) },
  { name: "browser_type", description: "入力欄へ文字列を入力します", inputSchema: object({ selector: { type: "string" }, text_locator: { type: "string" }, value: { type: "string" }, submit: { type: "boolean" } }, ["value"]) },
  { name: "browser_press_key", description: "キーを入力します", inputSchema: object({ key: { type: "string" } }, ["key"]) },
  { name: "browser_select_option", description: "select要素の値を変更します", inputSchema: object({ selector: { type: "string" }, value: { type: "string" } }, ["selector", "value"]) },
  { name: "browser_hover", description: "要素へホバーします", inputSchema: object({ selector: { type: "string" }, text: { type: "string" } }) },
  { name: "browser_drag", description: "要素間をドラッグします", inputSchema: object({ source_selector: { type: "string" }, target_selector: { type: "string" } }, ["source_selector", "target_selector"]) },
  { name: "browser_exec_js", description: "公開ページを制限付きPlaywrightコードで操作します", inputSchema: object({ code: { type: "string" }, timeout_ms: { type: "number" }, expects: { type: "string" } }, ["code"]) },
];

const text = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2).slice(0, 100_000) }],
  ...(isError ? { isError: true } : {}),
});

function locator(session: BrowserSession, args: Record<string, unknown>): Locator {
  const page = session.page();
  if (typeof args.selector === "string" && args.selector) return page.locator(args.selector).first();
  const label = typeof args.text === "string" ? args.text : typeof args.text_locator === "string" ? args.text_locator : undefined;
  if (label) return page.getByText(label, { exact: true }).first();
  throw new Error("selector または text を指定してください");
}

async function screenshot(session: BrowserSession, fullPage = false): Promise<CallToolResult> {
  const data = await session.page().screenshot({ type: "png", fullPage });
  return { content: [{ type: "image", data: data.toString("base64"), mimeType: "image/png" }] };
}

async function afterAction(session: BrowserSession, summary: string): Promise<CallToolResult> {
  const image = await screenshot(session);
  return { content: [{ type: "text", text: summary }, ...image.content] };
}

export async function callBrowserTool(session: BrowserSession, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  session.countAction();
  const page = session.page();
  try {
    switch (name) {
      case "browser_navigate": {
        const url = assertUrlAllowed(String(args.url ?? ""), session.config.allowedDomains);
        await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
        return afterAction(session, `opened ${page.url()}`);
      }
      case "browser_snapshot": {
        const body = page.locator("body");
        const snapshot = await body.ariaSnapshot({ timeout: session.config.actionTimeoutMs }).catch(async () => (await body.innerText()).slice(0, 100_000));
        return text({ url: page.url(), title: await page.title(), snapshot });
      }
      case "browser_screenshot":
        return screenshot(session, args.full_page === true);
      case "browser_wait_for": {
        const timeout = Math.min(Number(args.timeout_ms ?? session.config.actionTimeoutMs), session.config.actionTimeoutMs);
        if (typeof args.selector === "string") await page.locator(args.selector).first().waitFor({ timeout });
        else if (typeof args.text === "string") await page.getByText(args.text).first().waitFor({ timeout });
        else await page.waitForTimeout(Math.max(0, Math.min(timeout, 10_000)));
        return text({ status: "ready", url: page.url() });
      }
      case "browser_tabs": {
        const pages = session.browserContext().pages();
        if (args.action === "list") return text(pages.map((item, index) => ({ index, url: item.url() })));
        const index = Number(args.index);
        if (!Number.isInteger(index)) throw new Error("index を指定してください");
        if (args.action === "select") {
          const selected = session.selectPage(index);
          await selected.bringToFront();
          return text({ index, url: selected.url() });
        }
        if (args.action === "close") {
          await pages[index]?.close();
          session.selectPage(Math.max(0, Math.min(index - 1, session.browserContext().pages().length - 1)));
          return text({ closed: index });
        }
        throw new Error("action が正しくありません");
      }
      case "browser_click":
        await locator(session, args).click();
        return afterAction(session, "clicked");
      case "browser_type": {
        const target = locator(session, args);
        await target.fill(String(args.value ?? ""));
        if (args.submit === true) await target.press("Enter");
        return afterAction(session, "typed");
      }
      case "browser_press_key":
        await page.keyboard.press(String(args.key ?? ""));
        return afterAction(session, `pressed ${String(args.key ?? "")}`);
      case "browser_select_option":
        await page.locator(String(args.selector)).first().selectOption(String(args.value));
        return afterAction(session, "selected");
      case "browser_hover":
        await locator(session, args).hover();
        return afterAction(session, "hovered");
      case "browser_drag":
        await page.locator(String(args.source_selector)).first().dragTo(page.locator(String(args.target_selector)).first());
        return afterAction(session, "dragged");
      case "browser_exec_js": {
        const timeout = Math.min(Math.max(Number(args.timeout_ms ?? 30_000), 100), 30_000);
        const result = await executeRestrictedCode(session, String(args.code ?? ""), timeout);
        return text({ expects: args.expects, ...result });
      }
      default:
        return text(`未対応のBrowser Toolです: ${name}`, true);
    }
  } catch (error) {
    return text(error instanceof Error ? error.message : "Browser操作に失敗しました", true);
  }
}
