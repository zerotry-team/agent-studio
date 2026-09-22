import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { CALLBACK_PORT } from "./config.js";

export const CALLBACK_URL = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

export function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** 既定のブラウザで URL を開く。開けない環境では URL を表示して手動で開いてもらう。 */
export function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // 表示だけにする
  }
  console.log(`ブラウザで次の URL を開いてください（自動で開かない場合）:\n  ${url}\n`);
}

/**
 * ブラウザからの戻りを 1 回だけ受け取るローカル待ち受け。
 * `paths` のいずれかに来た query を返し、画面には日本語の完了メッセージを出す。
 */
export function waitForCallback(paths: string[], options: { timeoutMs?: number; page?: string } = {}): Promise<{ path: string; query: URLSearchParams }> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${CALLBACK_PORT}`);
      if (!paths.includes(url.pathname)) {
        response.writeHead(404, { connection: "close" }).end();
        return;
      }
      // 接続を使い回させない。使い回されると、次の待ち受け（同じポート）宛ての戻りが
      // 閉じたこのサーバーに届いて 404 になる
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" });
      response.end(options.page ?? "<html><body style=\"font-family:sans-serif\"><p>完了しました。この画面は閉じて、ターミナルに戻ってください。</p></body></html>");
      clearTimeout(timer);
      response.once("finish", () => server.closeAllConnections());
      server.close();
      resolve({ path: url.pathname, query: url.searchParams });
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("ブラウザからの応答を待ちましたが、時間内に完了しませんでした"));
    }, options.timeoutMs ?? 10 * 60_000);
    server.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`ローカルの待ち受け（ポート ${CALLBACK_PORT}）を開始できませんでした: ${error.message}`));
    });
    server.listen(CALLBACK_PORT, "127.0.0.1");
  });
}

/** ブラウザに自動送信フォームを表示するための一時ページ（GitHub App manifest 用） */
export function serveOnce(path: string, html: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== path) {
        response.writeHead(404, { connection: "close" }).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" });
      response.end(html);
      server.close();
      resolve();
    });
    server.on("error", reject);
    server.listen(CALLBACK_PORT + 1, "127.0.0.1");
  });
}
