import { describe, expect, it } from "vitest";
import { isChunkLoadFailure } from "./chunk-load-recovery";

describe("chunk load recovery", () => {
  it("rolling deployで発生するchunk読込失敗だけを検知する", () => {
    expect(isChunkLoadFailure(new Error("ChunkLoadError: Loading chunk 628 failed."))).toBe(true);
    expect(isChunkLoadFailure("Failed to fetch dynamically imported module" )).toBe(true);
    expect(isChunkLoadFailure(new Error("API request failed"))).toBe(false);
  });
});
