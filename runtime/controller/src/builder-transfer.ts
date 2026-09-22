import { createHash } from "node:crypto";

/**
 * Session Worker と Controller の間で Builder の作業領域を受け渡すための token。
 * Session・Change Set ごとに固定で、Agent Studio が平文を持たない MCP token の hash から作る。
 * Tool Gateway の builder-transfer.ts と同じ計算にする。
 */
export function builderTransferToken(sessionId: string, changeSetId: string, tokenHash: string): string {
  return createHash("sha256").update(`agent-studio-builder-workspace-v1\n${sessionId}\n${changeSetId}\n${tokenHash}`).digest("base64url");
}

/** Session Worker から見た受け渡し口（Tool Gateway の公開リスナー） */
export function builderTransferUrl(gatewayPublicUrl: string, sessionId: string, changeSetId: string): string {
  const url = new URL(gatewayPublicUrl);
  url.pathname = `/builder-workspaces/${sessionId}/${changeSetId}`;
  url.search = "";
  return url.toString();
}

export const builderInputKey = (changeSetId: string) => `builder-workspaces/${changeSetId}/input.tar.gz`;
export const builderResultKey = (changeSetId: string) => `builder-workspaces/${changeSetId}/result.json`;
export const builderBundleKey = (changeSetId: string) => `builder-workspaces/${changeSetId}/repo.bundle`;

/** Session Worker が送ってよい成果物（これ以外は受け取らない） */
export const BUILDER_ARTIFACT_LIMITS = {
  result: 1024 * 1024,
  bundle: 50 * 1024 * 1024,
} as const;
export type BuilderArtifactName = keyof typeof BUILDER_ARTIFACT_LIMITS;

export function builderArtifactKey(changeSetId: string, name: BuilderArtifactName): string {
  return name === "result" ? builderResultKey(changeSetId) : builderBundleKey(changeSetId);
}

/**
 * git bundle のヘッダだけを読む（git を実行しない）。
 * v2/v3 の形式: 1 行目がシグネチャ、`-<sha>` が前提 commit、`<sha> <ref>` が含まれる ref、空行で終わる。
 */
export function parseBundleHeader(bundle: Buffer): { prerequisites: string[]; refs: Array<{ sha: string; ref: string }> } {
  const end = bundle.indexOf("\n\n");
  if (end < 0) throw new Error("git bundle の形式が正しくありません");
  const lines = bundle.subarray(0, end).toString("utf8").split("\n");
  const signature = lines.shift();
  if (signature !== "# v2 git bundle" && signature !== "# v3 git bundle") throw new Error("git bundle の形式が正しくありません");
  const prerequisites: string[] = [];
  const refs: Array<{ sha: string; ref: string }> = [];
  for (const line of lines) {
    if (line.startsWith("@")) continue; // v3 capability
    const prerequisite = /^-([0-9a-f]{40,64})(?: .*)?$/.exec(line);
    if (prerequisite) {
      prerequisites.push(prerequisite[1]!);
      continue;
    }
    const ref = /^([0-9a-f]{40,64}) (\S+)$/.exec(line);
    if (!ref) throw new Error("git bundle の ref 行が正しくありません");
    refs.push({ sha: ref[1]!, ref: ref[2]! });
  }
  return { prerequisites, refs };
}
