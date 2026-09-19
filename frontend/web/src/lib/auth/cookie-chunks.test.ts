import { describe, expect, it } from "vitest";
import { chunkName, existingChunkNames, joinChunks, splitIntoChunks } from "./cookie-chunks";

describe("cookie chunks", () => {
  it("splits long values and joins them back", () => {
    const value = "x".repeat(9000);
    const chunks = splitIntoChunks(value, 3800);
    expect(chunks.map((c) => c.length)).toEqual([3800, 3800, 1400]);
    const jar = new Map(chunks.map((c, i) => [chunkName("as_session", i), c]));
    expect(joinChunks("as_session", (n) => jar.get(n))).toBe(value);
  });

  it("returns null when the first chunk is missing", () => {
    expect(joinChunks("as_session", () => undefined)).toBeNull();
  });

  it("finds existing chunk cookies only for the base name", () => {
    expect(existingChunkNames("as_session", ["as_session.0", "as_session.12", "as_session", "as_org", "as_sessionX.0"])).toEqual([
      "as_session.0",
      "as_session.12",
    ]);
  });
});
