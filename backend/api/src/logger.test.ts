import type pino from "pino";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

describe("logger redaction", () => {
  it("does not serialize headers, errors, or screenshot base64", () => {
    let output = "";
    const destination = { write: (chunk: string) => { output += chunk; } } as pino.DestinationStream;
    const image = "a".repeat(300);
    createLogger("info", "test", destination).info({
      req: { headers: { cookie: "session=private", authorization: "Bearer private-token" } },
      err: new Error("Cookie=session=private; Bearer private-token"),
      content: [{ type: "image", mimeType: "image/png", data: image }],
    }, "request failed");

    expect(output).not.toContain("private-token");
    expect(output).not.toContain("session=private");
    expect(output).not.toContain(image);
    expect(output).toContain("[REDACTED]");
  });
});
