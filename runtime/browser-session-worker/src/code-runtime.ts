import type { BrowserSession } from "./session.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
const FORBIDDEN = /\b(?:process|require|import\s*\(|child_process|worker_threads|node:|Deno|Bun)\b/;

export async function executeRestrictedCode(session: BrowserSession, code: string, timeoutMs: number): Promise<{ value: unknown; logs: string[]; displays: string[] }> {
  if (!session.config.codeExecutionEnabled || session.config.mode !== "public_ephemeral") {
    throw new Error("このBrowser Sessionではコード実行が無効です");
  }
  if (code.length > 20_000) throw new Error("code が長すぎます（上限 20,000 文字）");
  if (FORBIDDEN.test(code)) throw new Error("Node.js、ファイル、子プロセスへアクセスするコードは実行できません");
  const logs: string[] = [];
  const displays: string[] = [];
  const safeString = (value: unknown) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.slice(0, 20_000);
  };
  const consoleFacade = { log: (...values: unknown[]) => logs.push(values.map(safeString).join(" ").slice(0, 20_000)) };
  const display = (value: unknown) => displays.push(safeString(value));
  const fn = new AsyncFunction("page", "context", "console", "display", "process", "require", "fetch", `"use strict";\n${code}`);
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      fn(session.page(), session.browserContext(), consoleFacade, display, undefined, undefined, undefined),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`コード実行が ${timeoutMs}ms でタイムアウトしました`)), timeoutMs);
      }),
    ]);
    return { value: value === undefined ? null : value, logs: logs.slice(0, 100), displays: displays.slice(0, 20) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
