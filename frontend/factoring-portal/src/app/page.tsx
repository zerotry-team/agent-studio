"use client";

import { ArrowRight, Check, FileCheck2, Landmark, LockKeyhole, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { ScreeningInput, ScreeningView } from "@/lib/types";

const initialForm = {
  companyName: "株式会社みなと製作所",
  corporateNumber: "1234567890123",
  counterpartyName: "株式会社さかえ流通",
  counterpartyNumber: "9010001000001",
  applicationId: "INV-2026-0104",
  requestedAmount: "800000",
  invoiceAmount: "4300000",
  dueDate: "2026-11-30",
  bankFileId: "statement-2026-04-09",
};

const reasonLabels: Record<string, string> = {
  PAST_INQUIRY_UNDER_THRESHOLD: "過去のご相談履歴と申込金額を確認しました",
  PAYMENTS_CONSISTENT: "継続した入金実績を確認しました",
  CORPORATE_VERIFIED: "法人情報を確認しました",
};

function yen(value: string | number) {
  const amount = typeof value === "number" ? value : Number(value);
  return `${new Intl.NumberFormat("ja-JP").format(Number.isFinite(amount) ? amount : 0)}円`;
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(body.message ?? "通信に失敗しました");
  return body;
}

function Progress({ view }: { view: ScreeningView | null }) {
  const items = [
    { label: "申込受付", done: !!view },
    { label: "請求・入金確認", done: !!view?.progress.documents },
    { label: "審査結果", done: view?.status === "completed" },
  ];
  return (
    <ol className="progress" aria-label="審査の進み具合">
      {items.map((item, index) => (
        <li key={item.label} className={item.done ? "done" : view && index === items.findIndex((candidate) => !candidate.done) ? "active" : ""}>
          <span className="progress-mark">{item.done ? <Check aria-hidden="true" /> : index + 1}</span>
          <span>{item.label}</span>
        </li>
      ))}
    </ol>
  );
}

export default function HomePage() {
  const [form, setForm] = useState(initialForm);
  const [view, setView] = useState<ScreeningView | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const polling = useRef(false);
  const activeRunId = view?.id;
  const activeRunStatus = view?.status;

  useEffect(() => {
    const runId = new URLSearchParams(window.location.search).get("run");
    if (!runId) return;
    void fetch(`/api/screenings/${encodeURIComponent(runId)}`, { cache: "no-store" })
      .then((response) => responseJson<ScreeningView>(response))
      .then((restored) => {
        setView(restored);
        setError(null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "審査状況を復元できませんでした"));
  }, []);

  useEffect(() => {
    if (!activeRunId || activeRunStatus !== "running") return;
    const poll = async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        const next = await responseJson<ScreeningView>(await fetch(`/api/screenings/${encodeURIComponent(activeRunId)}`, { cache: "no-store" }));
        setView(next);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "審査状況を取得できませんでした");
      } finally {
        polling.current = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 1800);
    void poll();
    return () => window.clearInterval(timer);
  }, [activeRunId, activeRunStatus]);

  const requestedAmount = useMemo(() => yen(form.requestedAmount), [form.requestedAmount]);
  const update = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const input: ScreeningInput = {
        application_id: form.applicationId,
        applicant: { company_name: form.companyName, corporate_number: form.corporateNumber },
        counterparty: { company_name: form.counterpartyName, corporate_number: form.counterpartyNumber },
        requested_amount: Number(form.requestedAmount),
        invoice_amount: Number(form.invoiceAmount),
        invoice_due_date: form.dueDate,
        bank_statement_file_ids: [form.bankFileId],
        public_review_id: "ANON-CLEARFACT",
      };
      const started = await responseJson<ScreeningView>(await fetch("/api/screenings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }));
      window.history.replaceState(null, "", `?run=${encodeURIComponent(started.id)}`);
      setView(started);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "審査を開始できませんでした");
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    window.history.replaceState(null, "", window.location.pathname);
    setView(null);
    setError(null);
  };

  return (
    <div className="site-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="ClearFactor ホーム">
          <span className="brand-symbol" aria-hidden="true"><span /><span /><span /></span>
          <span>ClearFactor</span>
        </a>
        <nav aria-label="サポート">
          <span className="secure"><LockKeyhole aria-hidden="true" /> 暗号化通信</span>
          <a href="mailto:support@example.invalid">ご相談窓口</a>
        </nav>
      </header>

      <main id="top">
        <section className="hero">
          <div className="hero-copy">
            <p className="hero-kicker">請求書を、次の成長資金へ。</p>
            <h1>売掛金の資金化を、<br />迷わず前へ。</h1>
            <p className="hero-lead">必要事項を入力すると、請求・入金実績を安全に確認し、この場で事前審査結果をお知らせします。</p>
            <div className="trust-row">
              <span><ShieldCheck aria-hidden="true" /> 原本は社外へ送信しません</span>
              <span><Landmark aria-hidden="true" /> 正式契約前の事前審査です</span>
            </div>
          </div>
          <div className="invoice-motif" aria-hidden="true">
            <span className="motif-label">INVOICE</span>
            <span className="motif-amount">¥4,300,000</span>
            <span className="motif-line wide" />
            <span className="motif-line" />
            <span className="motif-stamp"><Check /> 確認</span>
          </div>
        </section>

        <section className="application-wrap" aria-labelledby="application-heading">
          <div className="application-intro">
            <p>事前審査</p>
            <h2 id="application-heading">かんたん申込</h2>
            <p className="application-note">このデモでは架空企業・架空請求書だけを使用しています。</p>
            <Progress view={view} />
            <div className="boundary-note">
              <LockKeyhole aria-hidden="true" />
              <div>
                <strong>大切なデータは企業環境内で処理</strong>
                <span>通帳原本や認証情報をAIへ直接渡しません。</span>
              </div>
            </div>
          </div>

          <div className="application-panel">
            {!view ? (
              <form onSubmit={submit} className="form-grid">
                <div className="form-section full">
                  <span className="section-number">1</span>
                  <div><h3>会社情報</h3><p>お申込み企業について入力してください。</p></div>
                </div>
                <label><span>会社名</span><input required value={form.companyName} onChange={(event) => update("companyName", event.target.value)} /></label>
                <label><span>法人番号</span><input required inputMode="numeric" pattern="[0-9]{13}" value={form.corporateNumber} onChange={(event) => update("corporateNumber", event.target.value)} /></label>

                <div className="form-section full">
                  <span className="section-number">2</span>
                  <div><h3>請求情報</h3><p>今回資金化したい請求書について入力してください。</p></div>
                </div>
                <label><span>請求書番号</span><input required value={form.applicationId} onChange={(event) => update("applicationId", event.target.value)} /></label>
                <label><span>売掛先企業</span><input required value={form.counterpartyName} onChange={(event) => update("counterpartyName", event.target.value)} /></label>
                <label><span>売掛先 法人番号</span><input required inputMode="numeric" pattern="[0-9]{13}" value={form.counterpartyNumber} onChange={(event) => update("counterpartyNumber", event.target.value)} /></label>
                <label><span>請求書額</span><span className="amount-input"><input required type="number" min="1" value={form.invoiceAmount} onChange={(event) => update("invoiceAmount", event.target.value)} /><i>円</i></span></label>
                <label><span>希望金額</span><span className="amount-input"><input required type="number" min="1" value={form.requestedAmount} onChange={(event) => update("requestedAmount", event.target.value)} /><i>円</i></span></label>
                <label><span>支払期日</span><input required type="date" value={form.dueDate} onChange={(event) => update("dueDate", event.target.value)} /></label>

                <div className="form-section full">
                  <span className="section-number">3</span>
                  <div><h3>入金実績</h3><p>企業環境内にある確認済み資料を指定します。</p></div>
                </div>
                <label className="full"><span>通帳資料の参照番号</span><input required value={form.bankFileId} onChange={(event) => update("bankFileId", event.target.value)} /><small>資料原本ではなく、安全な参照番号だけを送ります。</small></label>

                {error ? <p className="form-error full" role="alert">{error}</p> : null}
                <div className="submit-row full">
                  <div><span>事前審査の希望額</span><strong>{requestedAmount}</strong></div>
                  <button type="submit" disabled={submitting}>{submitting ? "受付中…" : "無料で事前審査する"}<ArrowRight aria-hidden="true" /></button>
                </div>
              </form>
            ) : view.status === "completed" ? (
              <section className="result" aria-live="polite">
                <span className="result-icon"><Check aria-hidden="true" /></span>
                <p className="result-label">事前審査結果</p>
                <h2>{view.decision === "可" ? "お申込みいただけます" : view.decision === "保留" ? "追加確認が必要です" : "今回はお申込みいただけません"}</h2>
                <p className="result-copy">希望金額 <strong>{requestedAmount}</strong> の事前確認が完了しました。正式な買取条件は担当者からご案内します。</p>
                <dl className="result-summary">
                  <div><dt>申込番号</dt><dd>{form.applicationId}</dd></div>
                  <div><dt>結果</dt><dd>{view.decision ?? "確認済み"}</dd></div>
                  <div><dt>社内記録</dt><dd>{view.recorded ? "完了" : "対象外"}</dd></div>
                </dl>
                {view.reasonCodes.length > 0 ? (
                  <div className="result-reasons">
                    <h3>確認できたこと</h3>
                    <ul>{view.reasonCodes.map((code) => <li key={code}><Check aria-hidden="true" />{reasonLabels[code] ?? "必要な確認項目を満たしています"}</li>)}</ul>
                  </div>
                ) : null}
                <div className="next-action">
                  <FileCheck2 aria-hidden="true" />
                  <div><strong>次は担当者からご連絡します</strong><span>この結果だけで契約や入金が確定することはありません。</span></div>
                </div>
                <button type="button" className="secondary-button" onClick={reset}>別の請求書を確認する</button>
              </section>
            ) : view.status === "failed" ? (
              <section className="processing" aria-live="polite">
                <span className="processing-mark error-mark">!</span>
                <h2>審査を完了できませんでした</h2>
                <p>{view.message}</p>
                <button type="button" className="secondary-button" onClick={reset}><RefreshCw aria-hidden="true" />入力内容を確認する</button>
              </section>
            ) : (
              <section className="processing" aria-live="polite">
                <span className="processing-mark"><span /></span>
                <p className="processing-label">安全に確認しています</p>
                <h2>{view.progress.decision ? "結果を確定しています" : view.progress.documents ? "審査基準を確認しています" : view.progress.received ? "請求・入金実績を確認しています" : "お申込みを受け付けました"}</h2>
                <p>画面を閉じずにお待ちください。通常は数分以内に結果が表示されます。</p>
                <Progress view={view} />
                {error ? <p className="form-error" role="alert">{error}</p> : null}
              </section>
            )}
          </div>
        </section>

        <section className="assurance" aria-label="安心してご利用いただくために">
          <article><ShieldCheck aria-hidden="true" /><h3>判断をAI任せにしない</h3><p>金額や履歴は、あらかじめ定めた同じ審査基準で確認します。</p></article>
          <article><LockKeyhole aria-hidden="true" /><h3>必要以上に持ち出さない</h3><p>原本と認証情報は企業環境に残し、必要な確認結果だけを利用します。</p></article>
          <article><FileCheck2 aria-hidden="true" /><h3>確認内容を記録する</h3><p>いつ、どの基準で確認したかを記録し、後から追跡できます。</p></article>
        </section>
      </main>

      <footer><span>ClearFactor</span><p>ハッカソン用デモ。実在企業の審査・契約には使用していません。</p></footer>
    </div>
  );
}
