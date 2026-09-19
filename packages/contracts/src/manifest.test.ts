import { describe, expect, it } from "vitest";
import { parseManifest, stringifyManifest } from "./manifest.js";
import { canonicalJson, toolCallHash } from "./common.js";

const yaml = `
agent:
  key: pricing-agent
  name: 価格変更エージェント
instructions: |
  指定された商品の価格を、指示された金額だけ変更する。
tools:
  - get_product
  - update_price@2
policies:
  - type: approval
    tool: update_price
    when: { field: price_change, op: ">", value: 500, abs: true }
environment:
  profile: sample-a-production
`;

describe("parseManifest", () => {
  it("正しい Manifest を読み込める", () => {
    const r = parseManifest(yaml);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.schema_version).toBe(1);
      expect(r.manifest.policies[0]).toMatchObject({ type: "approval", timeout_minutes: 1440 });
      expect(parseManifest(stringifyManifest(r.manifest)).ok).toBe(true);
    }
  });

  it("organization_id は受け付けない", () => {
    const r = parseManifest(`${yaml}\norganization_id: org_x\n`);
    expect(r.ok).toBe(false);
  });

  it("tools にないツールへのポリシーはエラー", () => {
    const r = parseManifest(yaml.replace("tool: update_price", "tool: delete_product"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.path).toBe("policies.0.tool");
  });

  it("ツールの重複はエラー", () => {
    const r = parseManifest(yaml.replace("- get_product", "- update_price"));
    expect(r.ok).toBe(false);
  });
});

describe("canonicalJson / toolCallHash", () => {
  it("キー順が違っても同じハッシュ", async () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [1, { y: 1, x: 2 }] } })).toBe('{"a":{"c":[1,{"x":2,"y":1}],"d":2},"b":1}');
    expect(await toolCallHash("t", { a: 1, b: 2 })).toBe(await toolCallHash("t", { b: 2, a: 1 }));
    expect(await toolCallHash("t", { a: 1 })).not.toBe(await toolCallHash("u", { a: 1 }));
  });
});
