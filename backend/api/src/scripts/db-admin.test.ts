import { beforeEach, expect, it, vi } from "vitest";
const client = vi.hoisted(() => ({ connect: vi.fn(), end: vi.fn(), query: vi.fn(), escapeLiteral: (s: string) => `'${s}'`, escapeIdentifier: (s: string) => `"${s}"` }));
vi.mock("pg", () => ({ default: { Client: vi.fn(function () { return client; }) } }));
import { ensureAppRole } from "./db-admin.js";
beforeEach(() => { vi.clearAllMocks(); });
it("既存ロール更新ではRDSで変更できない属性を再指定しない", async () => {
  client.query.mockResolvedValue({ rowCount: 1, rows: [{ rolsuper: false, rolbypassrls: false, db: "test" }] });
  await ensureAppRole({}, "test-password");
  const alter = client.query.mock.calls.find(([sql]) => sql.startsWith("ALTER ROLE"))?.[0];
  expect(alter).toContain("PASSWORD");
  expect(alter).not.toMatch(/SUPERUSER|BYPASSRLS|CREATEDB|CREATEROLE/);
  expect(client.end).toHaveBeenCalled();
});
it.each([{ rolsuper: true, rolbypassrls: false }, { rolsuper: false, rolbypassrls: true }, { rolcreatedb: true }, { rolcreaterole: true }])("管理者属性のある既存ロールは拒否する: %j", async (role) => {
  client.query.mockResolvedValue({ rowCount: 1, rows: [role] });
  await expect(ensureAppRole({}, "test-password")).rejects.toThrow("安全なアプリ用ロール");
  expect(client.query.mock.calls.some(([sql]) => sql.startsWith("ALTER ROLE"))).toBe(false);
  expect(client.end).toHaveBeenCalled();
});
