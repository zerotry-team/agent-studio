import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Db } from "./db.js";

/**
 * ファクタリング審査シナリオ用の基幹システムモック。
 * 申込者・請求書・入金実績を返し、審査結果を受け取る。
 * Tool Gateway が Bearer トークンを付けて呼ぶ（値は Runtime 側の設定から注入される）。
 */

function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!m) return false;
  const given = Buffer.from(m[1]!.trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const DECISIONS = ["可", "否", "保留"];

export interface FactoringApiOptions {
  token: string;
  db: Db;
  log?: (message: string, fields: Record<string, unknown>) => void;
}

export function createApp(opts: FactoringApiOptions): Hono {
  const { db } = opts;
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.use("*", async (c, next) => {
    if (!tokenMatches(c.req.header("authorization"), opts.token)) {
      return c.json({ error: "unauthorized", message: "認証に失敗しました" }, 401);
    }
    await next();
  });

  // 審査待ちの申込一覧。まず何を見ればいいかが分かる粒度にする
  app.get("/applications", async (c) => {
    const status = c.req.query("status") ?? "申込中";
    const applications = await db.query(
      `SELECT i.id AS invoice_id, i.invoice_number, i.amount, i.issued_on, i.due_on, i.status,
              a.id AS applicant_id, a.name AS applicant_name, a.applied_on,
              cp.id AS counterparty_id, cp.name AS counterparty_name
         FROM invoices i
         JOIN applicants a ON a.id = i.applicant_id
         JOIN counterparties cp ON cp.id = i.counterparty_id
        WHERE i.status = $1
        ORDER BY a.applied_on, i.id`,
      [status],
    );
    return c.json({ applications });
  });

  // 1 件の申込の全体像。審査に要る材料をまとめて返す
  app.get("/applications/:invoice_id", async (c) => {
    const invoiceId = c.req.param("invoice_id");
    const [invoice] = await db.query<{ applicant_id: string; counterparty_id: string; invoice_number: string }>(
      `SELECT i.*, a.name AS applicant_name, cp.name AS counterparty_name
         FROM invoices i
         JOIN applicants a ON a.id = i.applicant_id
         JOIN counterparties cp ON cp.id = i.counterparty_id
        WHERE i.id = $1`,
      [invoiceId],
    );
    if (!invoice) return c.json({ error: "not_found", message: `申込 ${invoiceId} が見つかりません` }, 404);

    const [applicant] = await db.query(`SELECT * FROM applicants WHERE id = $1`, [invoice.applicant_id]);
    const [counterparty] = await db.query(`SELECT * FROM counterparties WHERE id = $1`, [invoice.counterparty_id]);
    const payment_records = await db.query(
      `SELECT invoice_number, due_on, paid_on, amount
         FROM payment_records
        WHERE applicant_id = $1 AND counterparty_id = $2
        ORDER BY due_on`,
      [invoice.applicant_id, invoice.counterparty_id],
    );
    // 同じ請求書番号で過去にも申込がないか（二重譲渡の手がかり）
    const same_invoice_number = await db.query(
      `SELECT id AS invoice_id, status, issued_on, amount
         FROM invoices
        WHERE applicant_id = $1 AND invoice_number = $2 AND id <> $3
        ORDER BY issued_on`,
      [invoice.applicant_id, invoice.invoice_number, invoiceId],
    );
    const screenings = await db.query(
      `SELECT decision, advance_rate, fee_rate, reason, verified_corporate_number, screened_by, screened_at
         FROM screenings WHERE invoice_id = $1 ORDER BY screened_at DESC`,
      [invoiceId],
    );
    return c.json({ invoice, applicant, counterparty, payment_records, same_invoice_number, past_screenings: screenings });
  });

  // 売掛先の入金実績（申込をまたいで見たいとき）
  app.get("/counterparties/:id/payments", async (c) => {
    const id = c.req.param("id");
    const [counterparty] = await db.query(`SELECT * FROM counterparties WHERE id = $1`, [id]);
    if (!counterparty) return c.json({ error: "not_found", message: `売掛先 ${id} が見つかりません` }, 404);
    const payment_records = await db.query(
      `SELECT applicant_id, invoice_number, due_on, paid_on, amount
         FROM payment_records WHERE counterparty_id = $1 ORDER BY due_on`,
      [id],
    );
    return c.json({ counterparty, payment_records });
  });

  // 審査結果の書き戻し
  app.post("/screenings", async (c) => {
    let body: Record<string, unknown> | undefined;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      body = undefined;
    }
    const invoiceId = typeof body?.invoice_id === "string" ? body.invoice_id : "";
    const decision = typeof body?.decision === "string" ? body.decision : "";
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!invoiceId || !DECISIONS.includes(decision) || !reason) {
      return c.json(
        { error: "validation_error", message: `invoice_id、decision（${DECISIONS.join(" / ")}）、reason は必須です` },
        400,
      );
    }
    const [invoice] = await db.query(`SELECT id FROM invoices WHERE id = $1`, [invoiceId]);
    if (!invoice) return c.json({ error: "not_found", message: `申込 ${invoiceId} が見つかりません` }, 404);

    const rate = (value: unknown): number | null => {
      if (value === undefined || value === null) return null;
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0 || num > 1) return Number.NaN; // 0〜1 以外は入力エラー扱い
      return num;
    };
    const advanceRate = rate(body?.advance_rate);
    const feeRate = rate(body?.fee_rate);
    if (Number.isNaN(advanceRate) || Number.isNaN(feeRate)) {
      return c.json({ error: "validation_error", message: "advance_rate と fee_rate は 0〜1 の割合で指定してください" }, 400);
    }
    const corporateNumber = typeof body?.verified_corporate_number === "string" ? body.verified_corporate_number.trim() : null;
    if (corporateNumber && !/^\d{13}$/.test(corporateNumber)) {
      return c.json({ error: "validation_error", message: "verified_corporate_number は 13 桁の数字で指定してください" }, 400);
    }

    const [saved] = await db.query<{ id: string; screened_at: string }>(
      `INSERT INTO screenings (invoice_id, decision, advance_rate, fee_rate, reason, verified_corporate_number)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, screened_at`,
      [invoiceId, decision, advanceRate, feeRate, reason, corporateNumber],
    );
    opts.log?.("審査結果を記録しました", { invoice_id: invoiceId, decision });
    return c.json({ screening_id: String(saved!.id), invoice_id: invoiceId, decision, screened_at: saved!.screened_at });
  });

  app.notFound((c) => c.json({ error: "not_found", message: "見つかりません" }, 404));
  return app;
}
