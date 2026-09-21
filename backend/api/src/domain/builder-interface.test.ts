import { describe, expect, it } from "vitest";
import { inferCodeWorkspaceInterface } from "./builder-interface.js";

describe("inferCodeWorkspaceInterface", () => {
  it("依頼文から検索項目と取得項目を提案する", () => {
    expect(inferCodeWorkspaceInterface(
      "社内の契約DBから契約IDで契約状況と更新日だけを読み取るAgentを作る",
      "契約情報を取得する",
    )).toBe("契約IDで検索し、契約状況と更新日だけを取得する。登録・更新はしない。");
  });

  it("書き込み依頼は人の承認を必要とする提案にする", () => {
    expect(inferCodeWorkspaceInterface("社内CRMを更新する", "CRMへ審査結果を反映する"))
      .toContain("書き込み前に人の承認を必要とする");
  });
});
