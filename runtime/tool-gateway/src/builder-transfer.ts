import { createHash } from "node:crypto";

/**
 * Builder Session の作業領域を受け渡すときの token。Runtime Controller の builder-transfer.ts と同じ計算にする。
 * Session・Change Set ごとに固定で、Agent Studio が平文を持たない MCP token の hash から作る。
 */
export function builderTransferToken(sessionId: string, changeSetId: string, tokenHash: string): string {
  return createHash("sha256").update(`agent-studio-builder-workspace-v1\n${sessionId}\n${changeSetId}\n${tokenHash}`).digest("base64url");
}
