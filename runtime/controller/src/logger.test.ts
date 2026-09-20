import type pino from "pino";
import { describe, expect, it } from "vitest";
import { createLogger, errorInfo } from "./logger.js";

describe("logger redaction", () => {
  it("redacts secrets embedded in structured values and errors", () => {
    let output = "";
    const destination = { write: (chunk: string) => { output += chunk; } } as pino.DestinationStream;
    const logger = createLogger("info", "test", destination);
    logger.info({ headers: { cookie: "sid=private" }, err: errorInfo(new Error("Bearer private-token")) }, "checked");

    expect(output).not.toContain("sid=private");
    expect(output).not.toContain("private-token");
    expect(output).toContain("[REDACTED]");
  });
});
