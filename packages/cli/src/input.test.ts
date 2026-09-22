import { describe, expect, it } from "vitest";
import { flagString, parseArgs } from "./input.js";

describe("parseArgs", () => {
  it("位置引数とフラグを分け、値付き・値なし・= 形式を受け付ける", () => {
    const parsed = parseArgs(["connect", "notion", "--secret-stdin", "--name", "経理用", "--region=ap-northeast-1"]);
    expect(parsed.positional).toEqual(["connect", "notion"]);
    expect(parsed.flags).toEqual({ "secret-stdin": true, name: "経理用", region: "ap-northeast-1" });
    expect(flagString(parsed.flags, "secret-stdin")).toBeUndefined();
    expect(flagString(parsed.flags, "name")).toBe("経理用");
  });
});
