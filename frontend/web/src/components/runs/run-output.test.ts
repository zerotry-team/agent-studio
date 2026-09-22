import { describe, expect, it } from "vitest";
import { classifyRunOutput } from "./run-output";

describe("classifyRunOutput", () => {
  it("object JSONを構造化表示に分類する", () => {
    expect(classifyRunOutput('{"company":"燈株式会社","score":82}')).toEqual({
      kind: "json",
      value: { company: "燈株式会社", score: 82 },
    });
  });

  it("array JSONを構造化表示に分類する", () => {
    expect(classifyRunOutput('[{"status":"ok"}]')).toEqual({ kind: "json", value: [{ status: "ok" }] });
  });

  it("不完全なJSONらしい文字列はMarkdownとして保持する", () => {
    const output = '{"status": **確認中**';
    expect(classifyRunOutput(output)).toEqual({ kind: "markdown", value: output });
  });

  it("Markdownをそのまま保持する", () => {
    const output = "## 結果\n\n| 項目 | 確認結果 |\n|---|---|\n| 会社名 | **燈株式会社** |";
    expect(classifyRunOutput(output)).toEqual({ kind: "markdown", value: output });
  });
});
