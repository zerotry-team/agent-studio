import type { HttpToolAuth, RuntimeHttpTool } from "@agent-studio/contracts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MESSAGES } from "./messages.js";
import type { ConnectionSecretProvider } from "./secrets.js";
import { URL_PLACEHOLDER_RE } from "./tool-config.js";

/** 引数の誤りなど、モデルに直してもらえるエラー */
export class ToolInputError extends Error {
  override name = "ToolInputError";
}

export interface BuiltHttpRequest {
  method: RuntimeHttpTool["http"]["method"];
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export const MAX_RESPONSE_BYTES = 100 * 1024;
const ERROR_SNIPPET_CHARS = 500;

function queryValue(value: unknown): string {
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * ツール定義と引数から HTTP リクエストを組み立てる（認証ヘッダは別途 authHeader で足す）。
 * - URL の {param} は encodeURIComponent して埋め込み、その引数は取り除く
 * - GET / DELETE は残りの引数をクエリ文字列に、POST / PUT / PATCH は JSON 本文にする
 */
export function buildHttpRequest(tool: RuntimeHttpTool, args: Record<string, unknown>): BuiltHttpRequest {
  const rest: Record<string, unknown> = { ...args };
  const urlText = tool.http.url.replace(URL_PLACEHOLDER_RE, (_m, name: string) => {
    const value = rest[name];
    if (value === undefined || value === null || value === "") throw new ToolInputError(MESSAGES.missingUrlArgument(name));
    delete rest[name];
    return encodeURIComponent(typeof value === "object" ? JSON.stringify(value) : String(value));
  });

  const url = new URL(urlText);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ToolInputError("URL は http か https にしてください");

  const headers: Record<string, string> = { accept: "application/json, text/plain;q=0.9, */*;q=0.8", ...(tool.http.headers ?? {}) };
  const method = tool.http.method;

  if (method === "GET" || method === "DELETE") {
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined || value === null) continue;
      url.searchParams.append(key, queryValue(value));
    }
    return { method, url: url.toString(), headers };
  }
  headers["content-type"] = "application/json";
  return { method, url: url.toString(), headers, body: JSON.stringify(rest) };
}

/** 認証情報をヘッダにする。値の形式が違えば SecretUnavailable と同じ扱いにする（値は出さない） */
export function authHeader(auth: HttpToolAuth, secretValue: string): [string, string] | null {
  switch (auth.type) {
    case "none":
      return null;
    case "bearer":
      return ["authorization", `Bearer ${secretValue.trim()}`];
    case "header":
      return [auth.header_name.toLowerCase(), secretValue.trim()];
    case "basic": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(secretValue);
      } catch {
        throw new ToolInputError(MESSAGES.credentialsUnavailable);
      }
      const { username, password } = (parsed ?? {}) as { username?: unknown; password?: unknown };
      if (typeof username !== "string" || typeof password !== "string") throw new ToolInputError(MESSAGES.credentialsUnavailable);
      return ["authorization", `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`];
    }
  }
}

/** 応答本文を上限まで読む（巨大な応答でメモリを使い切らないよう、途中で読むのをやめる） */
async function readLimited(res: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - size));
      size = limit;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  // 途中で切った多バイト文字は置換文字になる
  return { text: new TextDecoder("utf-8").decode(Buffer.concat(chunks)), truncated };
}

export interface HttpToolExecutorDeps {
  secrets: ConnectionSecretProvider;
  fetch?: typeof fetch;
  userAgent?: string;
}

export interface HttpToolOutcome {
  result: CallToolResult;
  /** 監査ログ用の短い説明（引数・応答本文は含めない） */
  auditDetail?: string;
}

/** HTTP ツールを実行する。業務システムのエラー（非 2xx）は isError の結果にする */
export async function executeHttpTool(
  tool: RuntimeHttpTool,
  args: Record<string, unknown>,
  deps: HttpToolExecutorDeps,
): Promise<HttpToolOutcome> {
  const request = buildHttpRequest(tool, args);
  const auth = tool.http.auth;
  if (auth.type !== "none") {
    const header = authHeader(auth, await deps.secrets.get(auth.secret));
    if (header) request.headers[header[0]] = header[1];
  }
  if (deps.userAgent) request.headers["user-agent"] = deps.userAgent;

  const timeoutMs = tool.http.timeout_ms;
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(timeoutMs),
      // 別ホストへのリダイレクトで認証ヘッダが送られないよう、リダイレクトは追わない
      redirect: "manual",
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError") {
      return { result: textResult(MESSAGES.timeout(timeoutMs), true), auditDetail: "timeout" };
    }
    throw err;
  }

  const { text, truncated } = await readLimited(res, MAX_RESPONSE_BYTES);
  if (res.status < 200 || res.status >= 300) {
    const snippet = text.replace(/\s+/g, " ").trim().slice(0, ERROR_SNIPPET_CHARS);
    return { result: textResult(MESSAGES.httpError(res.status, snippet), true), auditDetail: `HTTP ${res.status}` };
  }
  const body = text.length > 0 ? text : `（HTTP ${res.status}、本文なし）`;
  return { result: textResult(truncated ? body + MESSAGES.truncated : body, false), auditDetail: `HTTP ${res.status}` };
}

export function textResult(text: string, isError: boolean): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}
