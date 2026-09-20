import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
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
      return [];
    }).request("/applications/INV-1", { headers: auth });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ invoice: { id: "INV-1" }, applicant: { id: "A-1" }, counterparty: { id: "C-1" } });
    expect(body.payment_records).toEqual([{ invoice_number: "X-0", paid_on: null }]);
    expect(body.same_invoice_number).toEqual([{ invoice_id: "INV-0", status: "取下げ" }]);
  });

  it("審査結果を記録する", async () => {
    const db = fakeDb((sql) => {
      if (sql.startsWith("SELECT id FROM invoices")) return [{ id: "INV-1" }];
      if (sql.includes("INSERT INTO screenings")) return [{ id: 7, screened_at: "2026-09-20T00:00:00.000Z" }];
      return [];
    });
    const res = await createApp({ token: "test-token", db }).request("/screenings", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ invoice_id: "INV-1", decision: "可", advance_rate: 0.85, fee_rate: 0.03, reason: "期日内入金が続いている", verified_corporate_number: "1234567890123" }),
    });
    expect(await res.json()).toMatchObject({ screening_id: "7", invoice_id: "INV-1", decision: "可" });
  });

  it("判定・理由・割合・法人番号の入力を検証する", async () => {
    const a = app((sql) => (sql.startsWith("SELECT id FROM invoices") ? [{ id: "INV-1" }] : []));
    const post = (body: unknown) =>
      a.request("/screenings", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

    expect((await post({ invoice_id: "INV-1", decision: "たぶん可", reason: "r" })).status).toBe(400);
    expect((await post({ invoice_id: "INV-1", decision: "可", reason: "" })).status).toBe(400);
    expect((await post({ invoice_id: "INV-1", decision: "可", reason: "r", advance_rate: 85 })).status).toBe(400);
    expect((await post({ invoice_id: "INV-1", decision: "可", reason: "r", verified_corporate_number: "12345" })).status).toBe(400);
  });
});
