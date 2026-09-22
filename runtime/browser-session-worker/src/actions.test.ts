import { describe, expect, it, vi } from "vitest";
import { callBrowserTool } from "./actions.js";

const artifact = {
  artifact_id: "11111111-1111-4111-8111-111111111111",
  filename: "report.csv",
  mime_type: "text/csv",
  size_bytes: 12,
  sha256: "a".repeat(64),
  scan_status: "passed" as const,
  retained_until: new Date(Date.now() + 60_000).toISOString(),
  body: Buffer.from("id,total\n1,100\n"),
};

function fakeSession(input: { hasForm?: boolean } = {}) {
  const setInputFiles = vi.fn(async () => undefined);
  const evaluate = vi.fn(async (fn: (element: unknown) => void) => {
    if (input.hasForm === false) {
      expect(() => fn({ form: null })).toThrow("Upload先に送信用のformがありません");
      throw new Error("Upload先に送信用のformがありません");
    }
    let submitted = false;
    fn({ form: { requestSubmit: () => { submitted = true; } } });
    expect(submitted).toBe(true);
  });
  const locator = { first: () => ({ setInputFiles, evaluate }) };
  const page = {
    url: () => "https://upload.example.com/form",
    locator: vi.fn(() => locator),
    screenshot: vi.fn(async () => Buffer.from("png")),
    waitForLoadState: vi.fn(async () => undefined),
  };
  return {
    config: { allowedDomains: ["upload.example.com"], allowPublicWeb: false },
    countAction: vi.fn(),
    page: () => page,
    artifactForUpload: vi.fn(() => artifact),
    ...{ pageMock: page, setInputFiles, evaluate },
  } as any;
}

describe("browser_upload", () => {
  it("承認済みArtifactを設定して同じTool内でform送信する", async () => {
    const session = fakeSession();
    const result = await callBrowserTool(session, "browser_upload", {
      selector: "input[type=file]",
      artifact_id: artifact.artifact_id,
      destination: "https://upload.example.com/form",
      filename: artifact.filename,
      sha256: artifact.sha256,
    });
    expect(result.isError).not.toBe(true);
    expect(session.setInputFiles).toHaveBeenCalledWith({
      name: artifact.filename,
      mimeType: artifact.mime_type,
      buffer: artifact.body,
    });
    expect(session.evaluate).toHaveBeenCalledOnce();
  });

  it("formがないUpload先は送信せずfail closedする", async () => {
    const session = fakeSession({ hasForm: false });
    const result = await callBrowserTool(session, "browser_upload", {
      selector: "input[type=file]",
      artifact_id: artifact.artifact_id,
      destination: "https://upload.example.com/form",
      filename: artifact.filename,
      sha256: artifact.sha256,
    });
    expect(result.isError).toBe(true);
    const first = result.content?.[0];
    expect(String(first && "text" in first ? first.text : first)).toContain("送信用のformがありません");
  });
});
