import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  documentRoot?: string;
}

export type FactoringDecision = {
  decision_candidate: "可" | "否" | "保留";
  decision_code: "approve_candidate" | "reject" | "hold";
  reason_codes: string[];
  reason_summary: string;
  rule_version: "factoring-v2";
  requires_human_approval: true;
};

type InternalHistory = {
  applicant_id: string;
  past_inquiry: boolean;
  internal_denied: boolean;
  inquiries: unknown[];
  active_risk_flags: unknown[];
  source: "factoring_demo.internal_records";
};

async function loadInternalHistory(db: Db, applicantId: string): Promise<InternalHistory> {
  const inquiries = await db.query(
    `SELECT id, inquired_on, requested_amount, channel, outcome
       FROM inquiry_history
      WHERE applicant_id = $1
      ORDER BY inquired_on DESC, id`,
    [applicantId],
  );
  const activeRiskFlags = await db.query<{ flag_type: string }>(
    `SELECT id, flag_type, reason_code, summary, recorded_on
       FROM internal_risk_flags
      WHERE applicant_id = $1 AND status = 'active'
      ORDER BY recorded_on DESC, id`,
    [applicantId],
  );
  return {
    applicant_id: applicantId,
    past_inquiry: inquiries.length > 0,
    internal_denied: activeRiskFlags.some((flag) => flag.flag_type === "denied"),
    inquiries,
    active_risk_flags: activeRiskFlags,
    source: "factoring_demo.internal_records",
  };
}

/** 金額・既存/新規・照合可否をLLMへ委ねないfail-closedルール。 */
export function evaluateFactoringDecision(body: Record<string, unknown>): FactoringDecision {
  const requestedAmount = typeof body.requested_amount === "number" ? body.requested_amount : Number.NaN;
  const application = body.application && typeof body.application === "object" ? body.application as Record<string, unknown> : undefined;
  const internalHistory = application?.internal_history && typeof application.internal_history === "object"
    ? application.internal_history as Record<string, unknown>
    : undefined;
  const pastInquiry = body.past_inquiry === true
    || internalHistory?.past_inquiry === true
    || (Array.isArray(application?.past_screenings) && application.past_screenings.length > 0);
  const duplicateInvoice = body.duplicate_invoice === true || (Array.isArray(application?.same_invoice_number) && application.same_invoice_number.length > 0);
  const internalDenied = body.internal_denied === true
    || internalHistory?.internal_denied === true
    || (Array.isArray(application?.internal_denied_matches) && application.internal_denied_matches.length > 0);
  const complianceResult = body.compliance && typeof body.compliance === "object" ? body.compliance as Record<string, unknown> : undefined;
  const compliance = body.compliance_status ?? complianceResult?.status;
  const corporateVerified = body.corporate_verified === true;
  const paymentSummary = body.payment_summary as { continuous_months?: unknown; all_payer_names_match?: unknown; image_readable?: unknown } | undefined;
  const continuousMonths = typeof paymentSummary?.continuous_months === "number" ? paymentSummary.continuous_months : 0;
  if (!Number.isFinite(requestedAmount) || requestedAmount < 0 || !["clear", "hit", "unavailable"].includes(String(compliance))) {
    throw new Error("判定入力が不正です");
  }
  const unavailable = [
    ["BROWSER_UNAVAILABLE", body.browser_status],
    ["DATABASE_UNAVAILABLE", body.database_status],
    ["OCR_UNAVAILABLE", body.ocr_status],
  ].filter(([, status]) => status === "unavailable").map(([code]) => String(code));
  const reasons: string[] = [];
  let candidate: FactoringDecision["decision_candidate"];
  let code: FactoringDecision["decision_code"];
  if (compliance === "hit" || internalDenied || duplicateInvoice) {
    candidate = "否";
    code = "reject";
    if (compliance === "hit") reasons.push("COMPLIANCE_HIT");
    if (internalDenied) reasons.push("INTERNAL_DENIED_LIST_HIT");
    if (duplicateInvoice) reasons.push("DUPLICATE_INVOICE");
  } else if (unavailable.length > 0 || compliance === "unavailable") {
    candidate = "保留";
    code = "hold";
    reasons.push(...unavailable);
    if (compliance === "unavailable") reasons.push("COMPLIANCE_UNAVAILABLE");
  } else if (paymentSummary?.image_readable === false || paymentSummary?.all_payer_names_match !== true || continuousMonths < 3) {
    candidate = "保留";
    code = "hold";
    if (paymentSummary?.image_readable === false) reasons.push("DOCUMENT_UNREADABLE");
    if (paymentSummary?.all_payer_names_match !== true) reasons.push("ACCOUNT_NAME_MISMATCH");
    if (continuousMonths < 3) reasons.push("PAYMENT_HISTORY_INSUFFICIENT");
  } else if (pastInquiry) {
    if (requestedAmount < 1_000_000) {
      candidate = "可";
      code = "approve_candidate";
      reasons.push("PAST_INQUIRY_UNDER_THRESHOLD", "PAYMENTS_CONSISTENT");
    } else {
      candidate = "保留";
      code = "hold";
      reasons.push("AMOUNT_REQUIRES_MANAGER_APPROVAL");
    }
  } else if (!corporateVerified) {
    candidate = "保留";
    code = "hold";
    reasons.push("CORPORATE_UNVERIFIED");
  } else if (requestedAmount < 300_000) {
    candidate = "可";
    code = "approve_candidate";
    reasons.push("NEW_UNDER_THRESHOLD", "COMPLIANCE_CLEAR", "PAYMENTS_CONSISTENT");
  } else {
    candidate = "保留";
    code = "hold";
    reasons.push("NEW_AMOUNT_OVER_THRESHOLD");
  }
  return { decision_candidate: candidate, decision_code: code, reason_codes: reasons, reason_summary: reasons.join(","), rule_version: "factoring-v2", requires_human_approval: true };
}

export function createApp(opts: FactoringApiOptions): Hono {
  const { db } = opts;
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/openapi.json", (c) => c.json({
    openapi: "3.1.0",
    info: { title: "Factoring Runtime API", version: "2.0.0" },
    paths: {
      "/compliance/{corporate_number}": { get: { operationId: "checkCompliance", summary: "Mockコンプライアンス情報を確認", parameters: [{ name: "corporate_number", in: "path", required: true, schema: { type: "string", pattern: "^[0-9]{13}$" } }], responses: { "200": { description: "ok" } } } },
    },
  }));

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
    const internal_history = await loadInternalHistory(db, invoice.applicant_id);
    return c.json({
      invoice,
      applicant,
      counterparty,
      payment_records,
      same_invoice_number,
      past_screenings: screenings,
      internal_history,
      data_sources: ["factoring_demo.applications", "factoring_demo.internal_records"],
    });
  });

  // 社内CRM/否決台帳に相当するDBを、申込者IDで明示的に照会する。
  // Agentへ任意SQLやDB資格情報は渡さず、必要最小限の構造化結果だけを返す。
  app.get("/internal-history/:applicant_id", async (c) => {
    const applicantId = c.req.param("applicant_id");
    const [applicant] = await db.query(`SELECT id FROM applicants WHERE id = $1`, [applicantId]);
    if (!applicant) return c.json({ error: "not_found", message: `申込者 ${applicantId} が見つかりません` }, 404);
    return c.json(await loadInternalHistory(db, applicantId));
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

  // E2E用のMock。実在人物・実在企業の信用情報には接続しない。
  app.get("/compliance/:corporate_number", (c) => {
    const corporateNumber = c.req.param("corporate_number");
    if (!/^\d{13}$/.test(corporateNumber)) return c.json({ error: "validation_error", message: "法人番号は13桁です" }, 400);
    return c.json({ corporate_number: corporateNumber, status: corporateNumber.endsWith("999") ? "hit" : "clear", source: "demo_fixture", checked_at: "2026-09-21T00:00:00.000Z" });
  });

  // PDFはRuntime内だけで読み、Control Plane/モデルへは月別集計と一致判定だけを返す。
  app.post("/documents/analyze", async (c) => {
    const body: { file_id?: unknown } = await c.req.json<{ file_id?: unknown }>().catch(() => ({}));
    const fileId = typeof body.file_id === "string" ? body.file_id : "";
    if (!/^[a-z0-9-]{1,80}$/.test(fileId)) return c.json({ error: "validation_error", message: "file_idが不正です" }, 400);
    const root = opts.documentRoot ?? fileURLToPath(new URL("../fixtures/", import.meta.url));
    let text: string;
    try { text = await readFile(join(root, `${fileId}.pdf`), "utf8"); }
    catch { return c.json({ error: "not_found", message: `文書 ${fileId} が見つかりません` }, 404); }
    const rows = [...text.matchAll(/TX\|(\d{4}-\d{2})\|([^|\r\n]+)\|(\d+)/g)].map((match) => ({ month: match[1]!, payer: match[2]!, amount: Number(match[3]) }));
    if (rows.length === 0) return c.json({ error: "document_unreadable", message: "取引行を抽出できません" }, 422);
    const byMonth = rows.map((row) => ({ month: row.month, amount: row.amount, payer_name_match: row.payer === "株式会社取引先" }));
    return c.json({ file_id: fileId, months: byMonth, continuous_months: new Set(rows.map((row) => row.month)).size, all_payer_names_match: byMonth.every((row) => row.payer_name_match), raw_text_included: false });
  });

  // 金額・存在・継続入金はLLMではなく、この決定的ルールで判定する。
  app.post("/decisions/evaluate", async (c) => {
    const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    try {
      return c.json(evaluateFactoringDecision(body));
    } catch {
      return c.json({ error: "validation_error", message: "判定入力が不正です" }, 400);
    }
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
    const idempotencyKey = typeof body?.idempotency_key === "string" ? body.idempotency_key.trim() : "";
    if (!invoiceId || !DECISIONS.includes(decision) || !reason || !/^[A-Za-z0-9:_-]{8,200}$/.test(idempotencyKey)) {
      return c.json(
        { error: "validation_error", message: `invoice_id、decision（${DECISIONS.join(" / ")}）、reason、idempotency_key は必須です` },
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

    const [saved] = await db.query<{ id: string; screened_at: string; inserted: boolean }>(
      `INSERT INTO screenings (invoice_id, decision, advance_rate, fee_rate, reason, verified_corporate_number, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING id, screened_at, (xmax = 0) AS inserted`,
      [invoiceId, decision, advanceRate, feeRate, reason, corporateNumber, idempotencyKey],
    );
    opts.log?.(saved!.inserted ? "審査結果を記録しました" : "同一審査結果を再利用しました", { invoice_id: invoiceId, decision, idempotency_key: idempotencyKey });
    return c.json({ screening_id: String(saved!.id), invoice_id: invoiceId, decision, screened_at: saved!.screened_at, created: saved!.inserted });
  });

  app.notFound((c) => c.json({ error: "not_found", message: "見つかりません" }, 404));
  return app;
}
