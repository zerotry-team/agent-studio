import { describe, expect, it } from "vitest";
import { classifyRunOutput } from "./run-output";
import { workspaceArtifactPath } from "./workspace-file-link";

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

describe("workspaceArtifactPath", () => {
  it("作業領域のパスを成果物のパスへ対応づける", () => {
    expect(workspaceArtifactPath("/workspace/generated_images/exec-1.png")).toBe("generated_images/exec-1.png");
    expect(workspaceArtifactPath("/workspace/outputs/report.csv")).toBe("report.csv");
    expect(workspaceArtifactPath("sandbox:/workspace/outputs/%E5%A0%B1%E5%91%8A.md")).toBe("報告.md");
  });

  it("作業領域以外と親ディレクトリ参照は対象にしない", () => {
    expect(workspaceArtifactPath("https://example.com/a.png")).toBeNull();
    expect(workspaceArtifactPath("/workspace/../etc/passwd")).toBeNull();
    expect(workspaceArtifactPath(undefined)).toBeNull();
  });
});
