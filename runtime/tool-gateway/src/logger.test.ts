import type pino from "pino";
import { describe, expect, it } from "vitest";
import { createLogger, errorMessage } from "./logger.js";

describe("logger redaction", () => {
  it("redacts tool arguments and credentials inside error messages", () => {
    let output = "";
    const destination = { write: (chunk: string) => { output += chunk; } } as pino.DestinationStream;
    const logger = createLogger("info", "test", destination);
    logger.info({ args: { password: "private-password" }, err: errorMessage(new Error("Authorization: Bearer private-token")) }, "failed");

    expect(output).not.toContain("private-password");
    expect(output).not.toContain("private-token");
    expect(output).toContain("[REDACTED]");
  });
});
