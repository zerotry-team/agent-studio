import { describe, expect, it } from "vitest";
import { toManifestDraft } from "../application/agents.js";
import { judge, renderTemplate } from "./engines.js";
import { isPrivateAddress } from "./studio-functions.js";

describe("isPrivateAddress（SSRF 対策）", () => {
  it.each(["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.5", "192.168.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"])(
    "内部: %s",
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
  it.each(["8.8.8.8", "52.95.1.1", "2606:4700::1111"])("公開: %s", (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe("renderTemplate（Workflow）", () => {
  it("入力と前のステップの出力を埋め込む", () => {
    const steps = [{ key: "research", type: "agent" as const, status: "completed" as const, run_id: "r", approval_id: null, output: "調査結果" }];
    expect(renderTemplate("依頼: {{input}} / 結果: {{ steps.research.output }} / {{steps.none.output}}", "価格", steps)).toBe(
      "依頼: 価格 / 結果: 調査結果 / ",
    );
  });
});

describe("judge（Eval）", () => {
  it("含む・含まないを判定する", () => {
    expect(judge("completed", "価格を400円下げました", null, { must_contain: ["400円"], must_not_contain: ["エラー"] })).toEqual([]);
    expect(judge("completed", "エラーです", null, { must_contain: ["400円"], must_not_contain: ["エラー"] })).toHaveLength(2);
    expect(judge("failed", "", "timeout", undefined)[0]).toContain("timeout");
  });
});

describe("toManifestDraft（日本語 → Manifest）", () => {
  it("存在しないツールを外し、承認条件をポリシーにする", () => {
    const draft = toManifestDraft(
      {
        key: "pricing-agent",
        name: "価格変更",
        description: "価格を変える",
        instructions: "価格を変更する",
        tools: ["get_product", "update_price", "unknown_tool"],
        approval_rules: [{ tool: "update_price", field: "price_change", op: ">", value: 500, abs: true, reason: "金額が大きい" }],
        environment_profile: "sample-a-production",
        notes: [],
      },
      new Set(["get_product", "update_price"]),
      new Set(["sample-a-production"]),
    );
    expect(draft.manifest_yaml).toContain("update_price");
    expect(draft.manifest_yaml).not.toContain("unknown_tool");
    expect(draft.manifest_yaml).toContain("price_change");
    expect(draft.notes.some((n) => n.includes("unknown_tool"))).toBe(true);
  });

  it("キーの形式が正しくなければ置き換える", () => {
    const draft = toManifestDraft(
      { key: "Pricing Agent!", name: "", description: "", instructions: "x", tools: [], approval_rules: [], environment_profile: null, notes: [] },
      new Set(),
      new Set(),
    );
    expect(draft.manifest_yaml).toContain("key: new-agent");
  });
});
