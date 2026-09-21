import { describe, expect, it } from "vitest";
import { createApp, evaluateFactoringDecision } from "./app.js";
import type { Db } from "./db.js";

const auth = { authorization: "Bearer test-token" };

/** SQL は投げずに、問い合わせごとに用意した行を返す */
function fakeDb(rowsFor: (sql: string, params: unknown[]) => unknown[]): Db & { calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      calls.push({ sql, params });
      return rowsFor(sql, params) as T[];
    },
    async close() {},
  };
}

const app = (rowsFor: (sql: string, params: unknown[]) => unknown[]) => createApp({ token: "test-token", db: fakeDb(rowsFor) });

describe("demo-factoring-api", () => {
  it("/health は認証なし、ほかはトークンが要る", async () => {
    const a = app(() => []);
    expect((await a.request("/health")).status).toBe(200);
    expect((await a.request("/applications")).status).toBe(401);
    expect((await a.request("/applications", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("申込一覧は既定で申込中だけを返す", async () => {
    const db = fakeDb(() => [{ invoice_id: "INV-1" }]);
    const res = await createApp({ token: "test-token", db }).request("/applications", { headers: auth });
    expect(await res.json()).toEqual({ applications: [{ invoice_id: "INV-1" }] });
    expect(db.calls[0]!.params).toEqual(["申込中"]);
  });

  it("無い申込は 404", async () => {
    const res = await app(() => []).request("/applications/INV-NOPE", { headers: auth });
    expect(res.status).toBe(404);
  });

  it("申込の詳細に入金実績と同一請求書番号の申込を含める", async () => {
    const res = await app((sql) => {
      if (sql.includes("FROM invoices i")) return [{ id: "INV-1", applicant_id: "A-1", counterparty_id: "C-1", invoice_number: "X-1" }];
      if (sql.includes("FROM applicants")) return [{ id: "A-1" }];
      if (sql.includes("FROM counterparties")) return [{ id: "C-1" }];
      if (sql.includes("FROM payment_records")) return [{ invoice_number: "X-0", paid_on: null }];
      if (sql.includes("FROM invoices\n")) return [{ invoice_id: "INV-0", status: "取下げ" }];
      if (sql.includes("FROM inquiry_history")) return [{ id: "INQ-1", requested_amount: 800000 }];
      if (sql.includes("FROM internal_risk_flags")) return [];
      return [];
    }).request("/applications/INV-1", { headers: auth });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ invoice: { id: "INV-1" }, applicant: { id: "A-1" }, counterparty: { id: "C-1" } });
    expect(body.payment_records).toEqual([{ invoice_number: "X-0", paid_on: null }]);
    expect(body.same_invoice_number).toEqual([{ invoice_id: "INV-0", status: "取下げ" }]);
    expect(body.internal_history).toEqual({
      applicant_id: "A-1",
      past_inquiry: true,
      internal_denied: false,
      inquiry_count: 1,
      active_risk_flag_count: 0,
      risk_reason_codes: [],
      source: "company_internal_api",
    });
  });

  it("社内DBの過去問い合わせと有効な否決フラグを明示的に照会する", async () => {
    const db = fakeDb((sql) => {
      if (sql.startsWith("SELECT id FROM applicants")) return [{ id: "A-3" }];
      if (sql.includes("FROM inquiry_history")) return [{ id: "INQ-7", requested_amount: 1200000 }];
      if (sql.includes("FROM internal_risk_flags")) return [{ id: "RISK-7", flag_type: "denied", reason_code: "DEMO_DENIED" }];
      return [];
    });
    const res = await createApp({ token: "test-token", db }).request("/internal-history/A-3", { headers: auth });
    expect(await res.json()).toEqual({
      applicant_id: "A-3",
      past_inquiry: true,
      internal_denied: true,
      inquiry_count: 1,
      active_risk_flag_count: 1,
      risk_reason_codes: ["DEMO_DENIED"],
      source: "company_internal_api",
    });
    expect(db.calls.some(({ sql, params }) => sql.includes("FROM inquiry_history") && params[0] === "A-3")).toBe(true);
    expect(db.calls.some(({ sql, params }) => sql.includes("FROM internal_risk_flags") && params[0] === "A-3")).toBe(true);
  });

  it("審査結果を記録する", async () => {
    const db = fakeDb((sql) => {
      if (sql.startsWith("SELECT id FROM invoices")) return [{ id: "INV-1" }];
      if (sql.includes("INSERT INTO screenings")) return [{ id: 7, screened_at: "2026-09-20T00:00:00.000Z", inserted: true }];
      return [];
    });
    const res = await createApp({ token: "test-token", db }).request("/screenings", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ invoice_id: "INV-1", decision: "可", advance_rate: 0.85, fee_rate: 0.03, reason: "期日内入金が続いている", verified_corporate_number: "1234567890123", idempotency_key: "workflow:run-1:screening" }),
    });
    expect(await res.json()).toMatchObject({ screening_id: "7", invoice_id: "INV-1", decision: "可" });
  });

  it("判定・理由・割合・法人番号の入力を検証する", async () => {
    const a = app((sql) => (sql.startsWith("SELECT id FROM invoices") ? [{ id: "INV-1" }] : []));
    const post = (body: unknown) =>
      a.request("/screenings", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

    expect((await post({ invoice_id: "INV-1", decision: "たぶん可", reason: "r" })).status).toBe(400);
    expect((await post({ invoice_id: "INV-1", decision: "可", reason: "" })).status).toBe(400);
    expect((await post({ invoice_id: "INV-1", decision: "可", reason: "r", advance_rate: 85, idempotency_key: "workflow:bad-rate" })).status).toBe(400);
    expect((await post({ invoice_id: "INV-1", decision: "可", reason: "r", verified_corporate_number: "12345", idempotency_key: "workflow:bad-company" })).status).toBe(400);
  });

  it("PDF fixtureをRuntime内で集計し、生本文を返さない", async () => {
    const res = await app(() => []).request("/documents/analyze", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ file_id: "statement-2026-04-09" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ continuous_months: 3, all_payer_names_match: true, raw_text_included: false });
  });

  it.each([
    [{ requested_amount: 800000, past_inquiry: true, duplicate_invoice: false, compliance_status: "clear", corporate_verified: true, payment_summary: { continuous_months: 3, all_payer_names_match: true } }, "可"],
    [{ requested_amount: 800000, past_inquiry: false, duplicate_invoice: true, compliance_status: "clear", corporate_verified: true, payment_summary: { continuous_months: 3, all_payer_names_match: true } }, "否"],
    [{ requested_amount: 800000, past_inquiry: false, duplicate_invoice: false, compliance_status: "unavailable", corporate_verified: false, payment_summary: { continuous_months: 1, all_payer_names_match: true } }, "保留"],
  ])("決定的ルールで可・否・保留を再現する", async (input, expected) => {
    const res = await app(() => []).request("/decisions/evaluate", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(input) });
    expect(await res.json()).toMatchObject({ decision_candidate: expected, rule_version: "factoring-v2", requires_human_approval: true });
  });

  const healthyBank = { continuous_months: 3, all_payer_names_match: true, image_readable: true };
  it.each([
    ["F-01", { requested_amount: 999999, past_inquiry: true, compliance_status: "clear", corporate_verified: true, payment_summary: healthyBank }, "approve_candidate", "PAST_INQUIRY_UNDER_THRESHOLD"],
    ["F-02", { requested_amount: 1000000, past_inquiry: true, compliance_status: "clear", corporate_verified: true, payment_summary: healthyBank }, "hold", "AMOUNT_REQUIRES_MANAGER_APPROVAL"],
    ["F-03", { requested_amount: 299999, past_inquiry: false, compliance_status: "clear", corporate_verified: true, payment_summary: healthyBank }, "approve_candidate", "NEW_UNDER_THRESHOLD"],
    ["F-04", { requested_amount: 300000, past_inquiry: false, compliance_status: "clear", corporate_verified: true, payment_summary: healthyBank }, "hold", "NEW_AMOUNT_OVER_THRESHOLD"],
    ["F-05", { requested_amount: 100000, past_inquiry: false, compliance_status: "hit", corporate_verified: true, payment_summary: healthyBank }, "reject", "COMPLIANCE_HIT"],
    ["F-06", { requested_amount: 100000, past_inquiry: false, internal_denied: true, compliance_status: "clear", corporate_verified: true, payment_summary: healthyBank }, "reject", "INTERNAL_DENIED_LIST_HIT"],
    ["F-07", { requested_amount: 100000, past_inquiry: false, compliance_status: "clear", corporate_verified: true, payment_summary: { continuous_months: 1, all_payer_names_match: false, image_readable: false } }, "hold", "DOCUMENT_UNREADABLE"],
    ["F-08", { requested_amount: 100000, past_inquiry: false, compliance_status: "clear", corporate_verified: true, browser_status: "unavailable", payment_summary: healthyBank }, "hold", "BROWSER_UNAVAILABLE"],
  ])("%sを決定的にfail-closed判定する", (_caseId, input, expected, reason) => {
    const decision = evaluateFactoringDecision(input);
    expect(decision.decision_code).toBe(expected);
    expect(decision.reason_codes).toContain(reason);
    expect(decision.requires_human_approval).toBe(true);
  });

  it("Workflowの構造化Tool出力から過去審査・重複・コンプライアンスを判定する", async () => {
    const res = await app(() => []).request("/decisions/evaluate", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        requested_amount: 800000,
        application: { past_screenings: [{ decision: "可" }], same_invoice_number: [] },
        compliance: { status: "clear" },
        corporate_verified: true,
        payment_summary: { continuous_months: 3, all_payer_names_match: true },
      }),
    });
    expect(await res.json()).toMatchObject({ decision_candidate: "可", reason_summary: "PAST_INQUIRY_UNDER_THRESHOLD,PAYMENTS_CONSISTENT" });
  });

  it("社内DBの構造化結果から過去問い合わせと社内否決を判定する", () => {
    const common = {
      requested_amount: 250000,
      compliance_status: "clear",
      corporate_verified: true,
      payment_summary: healthyBank,
    };
    expect(evaluateFactoringDecision({
      ...common,
      application: { internal_history: { past_inquiry: true, internal_denied: false } },
    }).reason_codes).toContain("PAST_INQUIRY_UNDER_THRESHOLD");
    expect(evaluateFactoringDecision({
      ...common,
      application: { internal_history: { past_inquiry: false, internal_denied: true } },
    })).toMatchObject({ decision_code: "reject", reason_codes: ["INTERNAL_DENIED_LIST_HIT"] });
  });
});
