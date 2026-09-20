import { describe, expect, it } from "vitest";
import { redactLogText, redactLogValue } from "./log-redaction.js";

describe("log redaction", () => {
  it("redacts sensitive keys at arbitrary nesting depths", () => {
    const value = redactLogValue({
      req: { headers: { Authorization: "Bearer top-secret", cookie: "session=abc" } },
      nested: { connection: { api_key: "sk-secret", password: "pw" } },
    });

    expect(value).toEqual({
      req: { headers: { Authorization: "[REDACTED]", cookie: "[REDACTED]" } },
      nested: { connection: { api_key: "[REDACTED]", password: "[REDACTED]" } },
    });
  });

  it("redacts image content and long base64 while preserving ordinary data", () => {
    const longBase64 = "a".repeat(300);
    expect(
      redactLogValue({
        content: [{ type: "image", mimeType: "image/png", data: longBase64 }, { type: "text", text: "safe" }],
        screenshot: `data:image/png;base64,${longBase64}`,
        shortId: "abc123",
      }),
    ).toEqual({
      content: [{ type: "image", mimeType: "image/png", data: "[REDACTED]" }, { type: "text", text: "safe" }],
      screenshot: "data:image/[REDACTED];base64,[REDACTED_BASE64]",
      shortId: "abc123",
    });
  });

  it("redacts credentials embedded in error strings", () => {
    const jwt = `eyJ${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`;
    const value = redactLogText(
      `request failed: Authorization: Bearer secret-token; Cookie=session=abc; https://example.com/?access_token=query-secret; {"api_key":"json-secret"}; ${jwt}`,
    );
    expect(value).not.toContain("secret-token");
    expect(value).not.toContain("session=abc");
    expect(value).not.toContain("query-secret");
    expect(value).not.toContain("json-secret");
    expect(value).not.toContain(jwt);
    expect(value).toContain("[REDACTED]");
  });

  it("redacts error messages, stacks, causes, and circular values", () => {
    const error = new Error("Bearer hidden-token");
    error.stack = "Error: Bearer hidden-token";
    (error as Error & { cause?: unknown }).cause = { cookie: "session=hidden" };
    const circular: Record<string, unknown> = { error };
    circular.self = circular;

    const value = redactLogValue(circular) as Record<string, unknown>;
    expect(JSON.stringify(value)).not.toContain("hidden-token");
    expect(JSON.stringify(value)).not.toContain("session=hidden");
    expect(value.self).toBe("[Circular]");
  });
});
