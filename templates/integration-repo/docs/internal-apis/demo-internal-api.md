# 社内 API: 商品管理システム（Sample A のデモ）

`${DEMO_API_BASE_URL}` に `Authorization: Bearer ${DEMO_API_TOKEN}` を付けて呼ぶ。応答はすべて JSON。

| メソッドとパス | 内容 | 応答 |
|---|---|---|
| `GET /products` | 全商品の一覧 | `{ products: [{ id, name, price, stock, currency }] }` |
| `GET /products/{id}` | 1 件の商品（例: `P-001`） | `{ id, name, price, stock, currency }` |
| `GET /orders` | 受注の一覧。`?status=受注中`（他に `出荷済み` / `取消`）で絞り込める | `{ orders: [{ order_id, product_id, quantity, ordered_on, status }] }` |
| `GET /suppliers` | 商品ごとの仕入先と納期 | `{ suppliers: [{ product_id, supplier, lead_time_days, min_order_quantity }] }` |
| `GET /stock-movements` | 入出庫の履歴。`?product_id=P-001` で絞り込める | `{ movements: [{ product_id, date, type, quantity }] }` |
| `POST /products/{id}/price` | 価格の変更（本文 `{ price_change }`、円） | `{ product_id, before, after }` |

- `price` は税込価格（円）、`stock` は在庫数、`currency` は常に `JPY`
- `ordered_on` と `date` は `YYYY-MM-DD`。`type` は `in`（入庫）か `out`（出庫）
- 404 は `{ error: "not_found", message }`、400 は `{ error: "validation_error", message }`、401 は認証の失敗
- 価格の変更は書き込みなので、読み取りだけの Tool では使わない
