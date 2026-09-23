import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const auth = { authorization: "Bearer test-token" };

describe("demo-internal-api", () => {
  it("/health は認証なしで返す", async () => {
    const res = await createApp({ token: "test-token" }).request("/health");
    expect(res.status).toBe(200);
  });

  it("トークンが無い・違うと 401", async () => {
    const app = createApp({ token: "test-token" });
    expect((await app.request("/products")).status).toBe(401);
    expect((await app.request("/products", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("商品の一覧と詳細", async () => {
    const app = createApp({ token: "test-token" });
    const list = (await (await app.request("/products", { headers: auth })).json()) as { products: unknown[] };
    expect(list.products.length).toBeGreaterThanOrEqual(3);
    const res = await app.request("/products/P-001", { headers: auth });
    expect(await res.json()).toMatchObject({ id: "P-001", price: 1480, currency: "JPY" });
    expect((await app.request("/products/NOPE", { headers: auth })).status).toBe(404);
  });

  it("価格を変更し、0 円未満にはしない", async () => {
    const app = createApp({ token: "test-token" });
    const post = (id: string, body: unknown) =>
      app.request(`/products/${id}/price`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

    expect(await (await post("P-001", { price_change: -400 })).json()).toEqual({ product_id: "P-001", before: 1480, after: 1080 });
    expect(await (await post("P-001", { price_change: -5000 })).json()).toEqual({ product_id: "P-001", before: 1080, after: 0 });
    expect((await post("P-001", { price_change: "abc" })).status).toBe(400);
    expect((await post("NOPE", { price_change: 1 })).status).toBe(404);
  });

  it("受注・仕入先・入出庫を読み取れる", async () => {
    const app = createApp({ token: "test-token" });
    const orders = (await (await app.request("/orders", { headers: auth })).json()) as { orders: Array<{ status: string }> };
    expect(orders.orders.length).toBeGreaterThanOrEqual(5);
    const open = (await (await app.request("/orders?status=受注中", { headers: auth })).json()) as { orders: Array<{ status: string }> };
    expect(open.orders.every((order) => order.status === "受注中")).toBe(true);
    expect((await app.request("/orders?status=unknown", { headers: auth })).status).toBe(400);

    const suppliers = (await (await app.request("/suppliers", { headers: auth })).json()) as { suppliers: Array<{ product_id: string; lead_time_days: number }> };
    expect(suppliers.suppliers.find((supplier) => supplier.product_id === "P-005")?.lead_time_days).toBe(45);

    const movements = (await (await app.request("/stock-movements?product_id=P-005", { headers: auth })).json()) as { movements: Array<{ product_id: string }> };
    expect(movements.movements.every((movement) => movement.product_id === "P-005")).toBe(true);
    expect((await app.request("/stock-movements?product_id=NOPE", { headers: auth })).status).toBe(404);
  });
});
