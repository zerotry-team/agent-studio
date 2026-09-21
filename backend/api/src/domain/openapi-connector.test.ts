import { describe, expect, it } from "vitest";
import { inspectOpenApi } from "./openapi-connector.js";

const document = {
  openapi: "3.1.0",
  info: { title: "Invoice Cloud", version: "1.0.0" },
  servers: [{ url: "https://api.example.com/v1" }],
  security: [{ ApiKey: [] }],
  components: {
    securitySchemes: { ApiKey: { type: "apiKey", in: "header", name: "X-Api-Key" } },
    schemas: {
      Invoice: {
        type: "object",
        properties: { amount: { type: "number" }, recipient: { type: "string" } },
        required: ["amount", "recipient"],
      },
    },
  },
  paths: {
    "/invoices/{invoice_id}": {
      parameters: [{ name: "invoice_id", in: "path", required: true, schema: { type: "string" } }],
      get: {
        operationId: "getInvoice",
        summary: "請求書を取得",
        responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Invoice" } } } } },
      },
      delete: { operationId: "deleteInvoice", summary: "請求書を削除", responses: { "204": { description: "deleted" } } },
    },
    "/invoices": {
      post: {
        operationId: "sendInvoice",
        summary: "請求書を送信",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Invoice" } } } },
        responses: { "201": { description: "created" } },
      },
    },
  },
};

describe("OpenAPI Connector Builder", () => {
  it("operation、入力schema、認証、決定的riskを生成する", () => {
    const proposal = inspectOpenApi({ document });
    expect(proposal.connector).toMatchObject({ key: "invoice-cloud", base_url: "https://api.example.com/v1", auth_type: "static_bearer" });
    expect(proposal.authentication).toMatchObject({ kind: "header_api_key", header_name: "X-Api-Key", requires_human_action: true });
    expect(proposal.operations.map((operation) => [operation.operation_id, operation.risk])).toEqual([
      ["getInvoice", "read"],
      ["deleteInvoice", "destructive"],
      ["sendInvoice", "financial"],
    ]);
    expect(proposal.operations[0]?.input_schema.required).toContain("invoice_id");
    expect(proposal.operations[0]?.output_schema).toMatchObject({ type: "object", required: ["amount", "recipient"] });
    expect(proposal.operations[2]?.input_schema.properties).toMatchObject({
      amount: { type: "number" },
      recipient: { type: "string" },
      idempotency_key: { type: "string" },
    });
    expect(proposal.operations[2]?.idempotency_key_field).toBe("idempotency_key");
  });

  it("選択したoperationだけselectedにする", () => {
    const proposal = inspectOpenApi({ document, selected_operation_ids: ["getInvoice"] });
    expect(proposal.operations.filter((operation) => operation.selected).map((operation) => operation.operation_id)).toEqual(["getInvoice"]);
  });

  it("社内APIはresponse schemaとfield allowlistを必須にする", () => {
    const internal = structuredClone(document);
    (internal.paths["/invoices/{invoice_id}"].get as Record<string, unknown>)["x-agent-studio-response-fields"] = ["amount"];
    expect(inspectOpenApi({ document: internal, internal_api: true, selected_operation_ids: ["getInvoice"] }).connector.adapter).toBe("internal_http_api");
    expect(() => inspectOpenApi({ document, internal_api: true, selected_operation_ids: ["getInvoice"] })).toThrow(/field/);
  });

  it("operation単位のsecurityも認証必須として扱う", () => {
    const operationSecurity = structuredClone(document);
    delete (operationSecurity as { security?: unknown }).security;
    (operationSecurity.paths["/invoices/{invoice_id}"].get as Record<string, unknown>).security = [{ ApiKey: [] }];
    expect(inspectOpenApi({ document: operationSecurity }).authentication).toMatchObject({
      kind: "header_api_key",
      requires_human_action: true,
    });
  });

  it("private URL、外部ref、risk引き下げを許可しない", () => {
    expect(() => inspectOpenApi({ document: { ...document, servers: [{ url: "https://127.0.0.1" }] } })).toThrow(/内部ネットワーク/);
    const externalRef = structuredClone(document);
    externalRef.paths["/invoices"].post.requestBody.content["application/json"].schema = { $ref: "https://evil.example/schema.json" } as never;
    expect(() => inspectOpenApi({ document: externalRef })).toThrow(/外部\$ref/);
    const lowered = structuredClone(document);
    (lowered.paths["/invoices/{invoice_id}"].delete as Record<string, unknown>)["x-agent-studio-risk"] = "read";
    expect(inspectOpenApi({ document: lowered }).operations.find((operation) => operation.operation_id === "deleteInvoice")?.risk).toBe("destructive");
  });
});
