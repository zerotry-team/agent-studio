import { describe, expect, it } from "vitest";
import { inspectArtifact, safeArtifactPath } from "./artifact-security.js";

describe("artifact security", () => {
  it("normalizes workspace output paths and detects PNG", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(inspectArtifact("/workspace/outputs/a/report.png", png)).toMatchObject({ path: "a/report.png", mimeType: "image/png", scanStatus: "passed" });
  });

  it("rejects traversal, executable files, and EICAR", () => {
    expect(() => safeArtifactPath("../secret.txt")).toThrow("不正");
    expect(inspectArtifact("payload.exe", Buffer.from("MZpayload")).scanStatus).toBe("rejected");
    expect(inspectArtifact("sample.txt", Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE")).scanStatus).toBe("rejected");
  });
});
