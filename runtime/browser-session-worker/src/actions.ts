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
  { name: "browser_download", description: "クリックで開始されるDownloadをこのRun専用Artifactとして安全検査し、本文をモデルへ返さずメタデータだけを返します", inputSchema: object({ selector: { type: "string" }, text: { type: "string" } }) },
  { name: "browser_upload", description: "このRunで取得したArtifact IDだけを現在の許可済みWeb画面へUploadします。Download時のfilenameとSHA-256の一致を必須にします", inputSchema: object({ selector: { type: "string" }, artifact_id: { type: "string" }, destination: { type: "string" }, filename: { type: "string" }, sha256: { type: "string" } }, ["selector", "artifact_id", "destination", "filename", "sha256"]) },
  { name: "computer_action", description: "許可されたBrowser window内でclick、type、scroll、dragを実行し、操作後のScreenshotを返します", inputSchema: object({ action: { type: "string", enum: ["click", "type", "scroll", "drag"] }, x: { type: "number" }, y: { type: "number" }, to_x: { type: "number" }, to_y: { type: "number" }, value: { type: "string" }, delta_x: { type: "number" }, delta_y: { type: "number" } }, ["action"]) },
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
        const url = assertUrlAllowed(String(args.url ?? ""), session.config.allowedDomains, session.config.allowPublicWeb);
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
      case "browser_download": {
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: session.config.actionTimeoutMs }),
          locator(session, args).click(),
        ]);
        return text(await session.saveDownload(download));
      }
      case "browser_upload": {
        const destination = new URL(String(args.destination ?? ""));
        const current = new URL(page.url());
        if (destination.protocol !== "https:" && destination.protocol !== "http:") throw new Error("Upload先URLが不正です");
        if (destination.hostname.toLowerCase() !== current.hostname.toLowerCase()) throw new Error("Upload先が現在の画面と一致しません");
        assertUrlAllowed(destination.toString(), session.config.allowedDomains, session.config.allowPublicWeb);
        const artifact = session.artifactForUpload({
          artifactId: String(args.artifact_id ?? ""),
          filename: String(args.filename ?? ""),
          sha256: String(args.sha256 ?? ""),
        });
        await page.locator(String(args.selector)).first().setInputFiles({ name: artifact.filename, mimeType: artifact.mime_type, buffer: artifact.body });
        return afterAction(session, `uploaded artifact ${artifact.artifact_id} (${artifact.filename}, ${artifact.sha256}) to ${destination.origin}`);
      }
      case "computer_action": {
        if (!session.config.computerActionsEnabled) throw new Error("このSessionではComputer Actionが許可されていません");
        const point = (name: "x" | "y" | "to_x" | "to_y", max: number, required = true) => {
          const value = Number(args[name]);
          if ((!Number.isFinite(value) || value < 0 || value > max) && required) throw new Error(`${name}がViewport外です`);
          return value;
        };
        const action = String(args.action ?? "");
        if (action === "click") {
          await page.mouse.click(point("x", session.config.viewport.width), point("y", session.config.viewport.height));
        } else if (action === "type") {
          const focused = await page.evaluate<{ type: string; autocomplete: string }>(
            `(() => { const element = document.activeElement; return element && element.tagName === "INPUT"
              ? { type: element.type || "", autocomplete: element.autocomplete || "" }
              : { type: "", autocomplete: "" }; })()`,
          );
          if (focused.type === "password" || /(?:one-time-code|current-password|new-password)/i.test(focused.autocomplete)) {
            throw new Error("password、MFAコードの入力は人間の操作が必要です");
          }
          await page.keyboard.type(String(args.value ?? ""));
        } else if (action === "scroll") {
          await page.mouse.wheel(Number(args.delta_x ?? 0), Number(args.delta_y ?? 0));
        } else if (action === "drag") {
          const x = point("x", session.config.viewport.width);
          const y = point("y", session.config.viewport.height);
          const toX = point("to_x", session.config.viewport.width);
          const toY = point("to_y", session.config.viewport.height);
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(toX, toY, { steps: 10 });
          await page.mouse.up();
        } else throw new Error("許可されていないComputer Actionです");
        return afterAction(session, `computer ${action}`);
      }
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
