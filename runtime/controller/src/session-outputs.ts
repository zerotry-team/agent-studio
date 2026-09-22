import { createHash } from "node:crypto";

/**
 * Session Worker が作業領域の成果物を Tool Gateway へ送るときの token。
 * Session ごとに固定で、Agent Studio が平文を持たない MCP token の hash から作るため、
 * 他の Session の token は作れない。Tool Gateway の session-outputs.ts と同じ計算にする。
 */
export function sessionOutputsToken(sessionId: string, tokenHash: string): string {
  return createHash("sha256").update(`agent-studio-session-outputs-v1\n${sessionId}\n${tokenHash}`).digest("base64url");
}

/** Session Worker から見た送信先（Tool Gateway の公開リスナー） */
export function sessionOutputsUrl(gatewayPublicUrl: string, sessionId: string): string {
  const url = new URL(gatewayPublicUrl);
  url.pathname = `/session-outputs/${sessionId}`;
  url.search = "";
  return url.toString();
}
