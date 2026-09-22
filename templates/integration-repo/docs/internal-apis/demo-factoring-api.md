# 社内 API: デモ審査システム（Sample A）

`${DEMO_API_BASE_URL}` に `Authorization: Bearer ${DEMO_API_TOKEN}` を付けて呼ぶ。応答はすべて JSON。

| メソッドとパス | 内容 | 応答 |
|---|---|---|
| `GET /applications?status=申込中` | 指定した状態の申込一覧（既定は `申込中`） | `{ applications: [{ invoice_id, invoice_number, amount, issued_on, due_on, status, applicant_id, applicant_name, applied_on, counterparty_id, counterparty_name }] }` |
| `GET /applications/{invoice_id}` | 1 件の申込の詳細（申込者・売掛先・入金実績・過去の審査） | `{ invoice, applicant, counterparty, payment_records, same_invoice_number, past_screenings, internal_history }` |
| `GET /counterparties/{id}/payments` | 売掛先の入金実績 | `{ counterparty, payment_records: [{ applicant_id, invoice_number, due_on, paid_on, amount }] }` |
| `GET /internal-history/{applicant_id}` | 申込者の社内の取引・否決の履歴 | 履歴の JSON |

- `paid_on` が `null` の入金実績は未入金。`paid_on` と `due_on` の差が入金の遅れ（日）
- 404 は `{ error: "not_found", message }`、401 は認証の失敗
