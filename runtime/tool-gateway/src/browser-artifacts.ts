import { createHash } from "node:crypto";
import { SESSION_ARTIFACT_MAX_BYTES, type SessionArtifactRequest, type SessionArtifactResponse, type SessionGrant } from "@agent-studio/contracts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export interface BrowserArtifactDeps {
  storeSessionArtifact(sessionId: string, body: SessionArtifactRequest): Promise<SessionArtifactResponse>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Browser Workerの browser_download が返すメタデータ（本文は含まない） */
const downloadMetadataSchema = z.object({
  artifact_id: z.uuid(),
  filename: z.string().min(1).max(255),
  mime_type: z.string().min(1).max(200),
  size_bytes: z.number().int().nonnegative().max(SESSION_ARTIFACT_MAX_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  scan_status: z.literal("passed"),
  retained_until: z.string(),
});

/** MCPのendpoint（…/mcp/<token>）から、同じSessionの本文取得URL（…/artifacts/<token>/<id>）を作る */
export function browserArtifactUrl(endpoint: string, artifactId: string): string {
  const url = new URL(endpoint);
  const match = /^\/mcp\/([^/]+)$/.exec(url.pathname);
  if (!match) throw new Error("Browser Sessionのendpoint形式が正しくありません");
  url.pathname = `/artifacts/${match[1]}/${encodeURIComponent(artifactId)}`;
  url.search = "";
  return url.toString();
}

/**
 * browser_download の結果を、Browser Worker内の一時保持からRun Artifact（Agent Studio）へ移す。
 * 本文はモデルへ返さず、保存できなかったDownloadは成功扱いにしない（fail closed）。
 */
export async function persistBrowserDownload(
  grant: SessionGrant,
  result: CallToolResult,
  deps: BrowserArtifactDeps,
): Promise<CallToolResult> {
  if (!grant.browser) throw new Error("Browser Session が起動していないか、すでに失われています");
  const text = result.content.find((item) => item.type === "text");
  let metadata: z.infer<typeof downloadMetadataSchema>;
  try {
    metadata = downloadMetadataSchema.parse(JSON.parse(text && "text" in text ? text.text : ""));
  } catch {
    throw new Error("Downloadの結果を読み取れませんでした");
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(browserArtifactUrl(grant.browser.endpoint, metadata.artifact_id), {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(deps.timeoutMs ?? 60_000),
  });
  if (!response.ok) throw new Error(`Downloadしたファイルを取り出せませんでした（HTTP ${response.status}）`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength !== metadata.size_bytes || body.byteLength > SESSION_ARTIFACT_MAX_BYTES) {
    throw new Error("Downloadしたファイルのサイズが一致しません");
  }
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (sha256 !== metadata.sha256) throw new Error("Downloadしたファイルのhashが一致しません");

  const stored = await deps.storeSessionArtifact(grant.session_id, {
    source: "browser_download",
    source_artifact_id: metadata.artifact_id,
    filename: metadata.filename,
    mime_type: metadata.mime_type,
    sha256,
    size_bytes: body.byteLength,
    content_base64: body.toString("base64"),
  });

  const output = {
    ...metadata,
    run_artifact_id: stored.run_artifact_id,
    run_artifact_path: stored.path,
    stored: true,
    upload_hint: "Uploadするときは artifact_id・filename・sha256 をこの値のまま browser_upload に渡してください。",
  };
  return { ...result, content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
}
