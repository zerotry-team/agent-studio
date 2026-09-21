import { describe, expect, it } from "vitest";
import { createConnectorSchema } from "./api.js";

const internalConnector = {
  key: "contracts-api",
  name: "契約API",
  description: "社内の契約状態を取得するAPI",
  adapter: "internal_http_api" as const,
  base_url: "https://api.company.example.com",
  operations: [{
    name: "lookup_contract",
    display_name: "契約照会",
    description: "契約状態を取得します",
    method: "GET" as const,
    path: "/contracts/{contract_id}",
    risk: "read" as const,
    input_schema: { type: "object", properties: { contract_id: { type: "string" } }, required: ["contract_id"] },
    output_schema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] },
    response_boundary: { allowed_fields: ["status"], max_bytes: 65_536, max_records: 1 },
  }],
};

describe("createConnectorSchema internal_http_api", () => {
  it("認証なしを拒否する", () => {
    expect(() => createConnectorSchema.parse({ ...internalConnector, auth_type: "none" })).toThrow(/認証/);
  });

  it("認証、response schema、field allowlistが揃えば受理する", () => {
    expect(createConnectorSchema.parse({ ...internalConnector, auth_type: "static_bearer" }).adapter).toBe("internal_http_api");
  });
});
