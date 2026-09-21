import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Download } from "playwright-core";
import { BrowserSession } from "./session.js";

const session = () => new BrowserSession({
  port: 0,
  sessionToken: "test-token",
  mode: "authenticated_restricted",
  allowPublicWeb: false,
  allowedDomains: ["example.com"],
  codeExecutionEnabled: false,
  computerActionsEnabled: false,
  viewport: { width: 1440, height: 900 },
  locale: "ja-JP",
  timezone: "Asia/Tokyo",
  actionTimeoutMs: 30_000,
  maxActions: 100,
});

function download(filename: string, body: Buffer): Download {
  return {
    failure: async () => null,
    createReadStream: async () => Readable.from(body),
    suggestedFilename: () => filename,
  } as unknown as Download;
}

describe("BrowserSession Run artifacts", () => {
  it("Download本文を返さずmetadataだけを作り、同一ID・filename・hashだけUploadへ渡す", async () => {
    const target = session();
    const saved = await target.saveDownload(download("report.csv", Buffer.from("id,total\n1,100\n")));
    expect(saved).toMatchObject({ filename: "report.csv", mime_type: "text/csv", size_bytes: 15, scan_status: "passed" });
    expect(saved.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(saved).not.toHaveProperty("body");

    const artifact = target.artifactForUpload({ artifactId: saved.artifact_id, filename: saved.filename, sha256: saved.sha256 });
    expect(artifact.body.toString()).toBe("id,total\n1,100\n");
    expect(() => target.artifactForUpload({ artifactId: saved.artifact_id, filename: "changed.csv", sha256: saved.sha256 })).toThrow("一致しません");
    expect(() => target.artifactForUpload({ artifactId: "00000000-0000-4000-8000-000000000000", filename: saved.filename, sha256: saved.sha256 })).toThrow("このRun");
  });

  it("実行形式とEICARをfail closedで拒否する", async () => {
    const target = session();
    await expect(target.saveDownload(download("payload.exe", Buffer.from("MZ malicious")))).rejects.toThrow("安全検査");
    await expect(target.saveDownload(download("eicar.txt", Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE")))).rejects.toThrow("安全検査");
  });
});
