import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";

/**
 * 受け入れシナリオ用の社内 API モック（商品と価格）。
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
  log?: (message: string, fields: Record<string, unknown>) => void;
}

export function createApp(opts: DemoApiOptions): Hono {
  const products = new Map((opts.products ?? seedProducts()).map((p) => [p.id, { ...p }]));
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
