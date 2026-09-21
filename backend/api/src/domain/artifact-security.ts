import { createHash } from "node:crypto";

const MIME_BY_EXTENSION: Record<string, string> = {
  csv: "text/csv",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  txt: "text/plain",
  webp: "image/webp",
};

/** Run外へ抜けない相対パスに正規化する。 */
export function safeArtifactPath(input: string): string {
  const raw = input.replace(/^\/workspace\/outputs\//, "").replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = raw.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === ".." || part.includes("\0"))) throw new Error("Artifact pathが不正です");
  return parts.join("/").slice(0, 500);
}

export function artifactMimeType(path: string, bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 4).toString("ascii") === "%PDF") return "application/pdf";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

/**
 * 同期のingress検査。既知のEICAR文字列と実行形式をfail closedで拒否する。
 * 本番ではこのpassedレコードをGuardDuty Malware Protection等の非同期結果で再検証できる。
 */
export function inspectArtifact(pathInput: string, bytes: Buffer) {
  const path = safeArtifactPath(pathInput);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const executable = bytes.subarray(0, 2).toString("ascii") === "MZ" || bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const eicar = bytes.toString("latin1").includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE");
  return {
    path,
    sha256,
    mimeType: artifactMimeType(path, bytes),
    scanStatus: executable || eicar ? "rejected" as const : "passed" as const,
    scanEngine: "agent-studio-ingress-v1",
  };
}
