import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";

/**
 * 受け入れシナリオ用の社内 API モック（商品・価格・受注・仕入先・入出庫）。
 * Tool Gateway が Secrets Manager の値を Bearer トークンとして付けて呼ぶ。
 */

export interface Product {
  id: string;
  name: string;
  /** 税込価格（円） */
  price: number;
  stock: number;
  currency: "JPY";
}

export function seedProducts(): Product[] {
  return [
    { id: "P-001", name: "有機栽培コーヒー豆 200g", price: 1480, stock: 120, currency: "JPY" },
    { id: "P-002", name: "国産ひのきのまな板", price: 3980, stock: 35, currency: "JPY" },
    { id: "P-003", name: "九谷焼 湯呑み（藍）", price: 2750, stock: 18, currency: "JPY" },
    { id: "P-004", name: "今治タオル フェイスタオル 2 枚組", price: 1650, stock: 240, currency: "JPY" },
    { id: "P-005", name: "南部鉄器 急須 0.6L", price: 8800, stock: 9, currency: "JPY" },
  ];
}

export interface Order {
  order_id: string;
  product_id: string;
  quantity: number;
  ordered_on: string;
  /** 受注中 / 出荷済み / 取消 */
  status: "受注中" | "出荷済み" | "取消";
}

export interface Supplier {
  product_id: string;
  supplier: string;
  /** 発注から入荷までの日数 */
  lead_time_days: number;
  min_order_quantity: number;
}

export interface StockMovement {
  product_id: string;
  date: string;
  /** in = 入庫、out = 出庫 */
  type: "in" | "out";
  quantity: number;
}

export function seedOrders(): Order[] {
  return [
    { order_id: "O-1001", product_id: "P-005", quantity: 4, ordered_on: "2026-09-18", status: "出荷済み" },
    { order_id: "O-1002", product_id: "P-003", quantity: 6, ordered_on: "2026-09-19", status: "出荷済み" },
    { order_id: "O-1003", product_id: "P-005", quantity: 3, ordered_on: "2026-09-20", status: "受注中" },
    { order_id: "O-1004", product_id: "P-001", quantity: 12, ordered_on: "2026-09-20", status: "出荷済み" },
    { order_id: "O-1005", product_id: "P-002", quantity: 2, ordered_on: "2026-09-21", status: "取消" },
    { order_id: "O-1006", product_id: "P-005", quantity: 2, ordered_on: "2026-09-22", status: "受注中" },
    { order_id: "O-1007", product_id: "P-004", quantity: 20, ordered_on: "2026-09-22", status: "受注中" },
  ];
}

export function seedSuppliers(): Supplier[] {
  return [
    { product_id: "P-001", supplier: "みどり珈琲商会", lead_time_days: 7, min_order_quantity: 24 },
    { product_id: "P-002", supplier: "木曽ひのき工房", lead_time_days: 21, min_order_quantity: 10 },
    { product_id: "P-003", supplier: "九谷陶苑", lead_time_days: 30, min_order_quantity: 12 },
    { product_id: "P-004", supplier: "今治タオル協同組合", lead_time_days: 10, min_order_quantity: 50 },
    { product_id: "P-005", supplier: "南部鉄器 盛岡工房", lead_time_days: 45, min_order_quantity: 6 },
  ];
}

export function seedStockMovements(): StockMovement[] {
  return [
    { product_id: "P-005", date: "2026-09-16", type: "in", quantity: 12 },
    { product_id: "P-005", date: "2026-09-18", type: "out", quantity: 4 },
    { product_id: "P-005", date: "2026-09-20", type: "out", quantity: 3 },
    { product_id: "P-005", date: "2026-09-22", type: "out", quantity: 2 },
    { product_id: "P-003", date: "2026-09-15", type: "in", quantity: 24 },
    { product_id: "P-003", date: "2026-09-19", type: "out", quantity: 6 },
    { product_id: "P-001", date: "2026-09-14", type: "in", quantity: 60 },
    { product_id: "P-001", date: "2026-09-20", type: "out", quantity: 12 },
    { product_id: "P-002", date: "2026-09-17", type: "in", quantity: 20 },
    { product_id: "P-004", date: "2026-09-12", type: "in", quantity: 120 },
  ];
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!m) return false;
  const given = Buffer.from(m[1]!.trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface DemoApiOptions {
  token: string;
  products?: Product[];
  orders?: Order[];
  suppliers?: Supplier[];
  movements?: StockMovement[];
  log?: (message: string, fields: Record<string, unknown>) => void;
}

export function createApp(opts: DemoApiOptions): Hono {
  const products = new Map((opts.products ?? seedProducts()).map((p) => [p.id, { ...p }]));
  const orders = (opts.orders ?? seedOrders()).map((o) => ({ ...o }));
  const suppliers = (opts.suppliers ?? seedSuppliers()).map((s) => ({ ...s }));
  const movements = (opts.movements ?? seedStockMovements()).map((m) => ({ ...m }));
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.use("*", async (c, next) => {
    if (!tokenMatches(c.req.header("authorization"), opts.token)) {
      return c.json({ error: "unauthorized", message: "認証に失敗しました" }, 401);
    }
    await next();
  });

  app.get("/products", (c) => c.json({ products: [...products.values()] }));

  app.get("/products/:id", (c) => {
    const product = products.get(c.req.param("id"));
    if (!product) return c.json({ error: "not_found", message: `商品 ${c.req.param("id")} が見つかりません` }, 404);
    return c.json(product);
  });

  // 受注（status で絞り込める）
  app.get("/orders", (c) => {
    const status = c.req.query("status");
    if (status && !["受注中", "出荷済み", "取消"].includes(status)) {
      return c.json({ error: "validation_error", message: "status は 受注中 / 出荷済み / 取消 のいずれかです" }, 400);
    }
    return c.json({ orders: status ? orders.filter((o) => o.status === status) : orders });
  });

  // 仕入先と納期
  app.get("/suppliers", (c) => c.json({ suppliers }));

  // 入出庫の履歴（商品 ID で絞り込める）
  app.get("/stock-movements", (c) => {
    const productId = c.req.query("product_id");
    if (productId && !products.has(productId)) {
      return c.json({ error: "not_found", message: `商品 ${productId} が見つかりません` }, 404);
    }
    return c.json({ movements: productId ? movements.filter((m) => m.product_id === productId) : movements });
  });

  app.post("/products/:id/price", async (c) => {
    const product = products.get(c.req.param("id"));
    if (!product) return c.json({ error: "not_found", message: `商品 ${c.req.param("id")} が見つかりません` }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    const change = (body as { price_change?: unknown } | undefined)?.price_change;
    if (typeof change !== "number" || !Number.isFinite(change)) {
      return c.json({ error: "validation_error", message: "price_change には数値（円）を指定してください" }, 400);
    }
    const before = product.price;
    // 円未満は四捨五入し、0 円未満にはしない
    const after = Math.max(0, Math.round(before + change));
    product.price = after;
    opts.log?.("価格を変更しました", { product_id: product.id, before, after, price_change: change });
    return c.json({ product_id: product.id, before, after });
  });

  app.notFound((c) => c.json({ error: "not_found", message: "見つかりません" }, 404));
  return app;
}
