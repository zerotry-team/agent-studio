import { describe, expect, it } from "vitest";
import { filterResponseFields, validateJsonSchema } from "./response-boundary.js";

const boundary = { allowed_fields: ["status", "updated_at"], max_bytes: 65536, max_records: 100, allow_sensitive_fields: false };

describe("response boundary", () => {
  it("許可field以外をモデルへ渡さない", () => {
    expect(filterResponseFields({ customer_name: "田中", bank_account: "x", status: "active", updated_at: "2026-09-22" }, boundary)).toEqual({
      status: "active",
      updated_at: "2026-09-22",
    });
  });

  it("許可されていても機微fieldは明示解除なしで拒否する", () => {
    expect(() => filterResponseFields({ bank_account: "x" }, { ...boundary, allowed_fields: ["bank_account"] })).toThrow(/機微情報/);
  });

  it("schema driftを検知する", () => {
    expect(() => validateJsonSchema({ status: 123 }, { type: "object", required: ["status"], properties: { status: { type: "string" } } })).toThrow(/string/);
  });
});
