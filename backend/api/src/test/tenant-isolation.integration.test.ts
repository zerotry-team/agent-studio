import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

/**
 * 組織の分離（SEC-01 / SEC-04 / SEC-16）。アプリのバグがあっても、DB が他組織の行を返さないことを確かめる。
 */
describe("組織の分離（RLS）", () => {
  let h: Harness;
  let orgA: { id: string };
  let orgB: { id: string };
  let agentB: { id: string };
  let toolB: { id: string };

  beforeAll(async () => {
    h = createHarness();
    orgA = await h.createOrg("rls-a", [{ email: `owner-a-${h.suffix}@example.com`, role: "owner" }]);
    orgB = await h.createOrg("rls-b", [{ email: `owner-b-${h.suffix}@example.com`, role: "owner" }]);
    agentB = await h.admin.agents.create({ data: { organization_id: orgB.id, key: "secret-agent", name: "B の秘密" } });
    toolB = await h.admin.tools.create({
      data: { organization_id: orgB.id, name: "b_tool", display_name: "B", execution_location: "runtime_mcp", risk: "read" },
    });
  });
  afterAll(async () => h.close());

  it("組織に属するテーブルはすべて RLS が有効", async () => {
    const rows = await h.admin.$queryRaw<{ table_name: string; rls: boolean }[]>`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls
        FROM pg_class c
        JOIN information_schema.columns col ON col.table_name = c.relname AND col.column_name = 'organization_id'
       WHERE c.relkind = 'r' AND col.table_schema = 'public'`;
    expect(rows.length).toBeGreaterThan(15);
    expect(rows.filter((r) => !r.rls).map((r) => r.table_name)).toEqual([]);
  });

  it("アプリのロールは RLS を回避できず、テーブルの所有者でもない", async () => {
    const [role] = await h.admin.$queryRaw<{ rolbypassrls: boolean; rolsuper: boolean }[]>`
      SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'agent_studio_app'`;
    expect(role).toEqual({ rolbypassrls: false, rolsuper: false });
    const owned = await h.admin.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'agent_studio_app'`;
    expect(Number(owned[0]!.n)).toBe(0);
  });

  it("A 社の文脈では B 社の行が見えない", async () => {
    const seen = await h.deps.db.org(orgA.id, (tx) => tx.agents.findMany({ where: { id: agentB.id } }));
    expect(seen).toEqual([]);
    const all = await h.deps.db.org(orgA.id, (tx) => tx.agents.findMany());
    expect(all.every((a) => a.organization_id === orgA.id)).toBe(true);
  });

  it("組織の文脈がなければ何も見えない", async () => {
    const seen = await h.deps.db.run({ organizationId: null, userId: null }, (tx) => tx.agents.findMany());
    expect(seen).toEqual([]);
  });

  it("A 社の文脈で B 社の行は作れない", async () => {
    await expect(
      h.deps.db.org(orgA.id, (tx) => tx.agents.create({ data: { organization_id: orgB.id, key: "x", name: "x" } })),
    ).rejects.toThrow();
  });

  it("A 社の文脈で B 社の行は更新・削除できない（0件）", async () => {
    const updated = await h.deps.db.org(orgA.id, (tx) => tx.agents.updateMany({ where: { id: agentB.id }, data: { name: "hacked" } }));
    expect(updated.count).toBe(0);
    const deleted = await h.deps.db.org(orgA.id, (tx) => tx.agents.deleteMany({ where: { id: agentB.id } }));
    expect(deleted.count).toBe(0);
    const still = await h.admin.agents.findUniqueOrThrow({ where: { id: agentB.id } });
    expect(still.name).toBe("B の秘密");
  });

  it("複合外部キーにより、自組織の行から他組織の行は参照できない", async () => {
    // RLS の外（所有者）でも、organization_id が違う組み合わせは DB が拒否する
    await expect(
      h.admin.tool_versions.create({ data: { organization_id: orgA.id, tool_id: toolB.id, version: 1, spec: {} } }),
    ).rejects.toThrow();
  });

  it("利用者は自分の運営管理者フラグを変更できない", async () => {
    const user = await h.admin.users.findUniqueOrThrow({ where: { email: `owner-a-${h.suffix}@example.com` } });
    await expect(
      h.deps.db.run({ organizationId: null, userId: user.id }, (tx) =>
        tx.users.update({ where: { id: user.id }, data: { is_platform_admin: true } }),
      ),
    ).rejects.toThrow();
  });

  it("監査ログはアプリから書き換え・削除できない", async () => {
    await h.deps.db.org(orgA.id, (tx) =>
      tx.audit_logs.createMany({ data: [{ organization_id: orgA.id, actor_type: "system", action: "test", result: "success" }] }),
    );
    await expect(h.deps.db.org(orgA.id, (tx) => tx.audit_logs.updateMany({ data: { action: "tampered" } }))).rejects.toThrow();
    await expect(h.deps.db.org(orgA.id, (tx) => tx.audit_logs.deleteMany({}))).rejects.toThrow();
  });

  it("API: 所属していない組織を指定すると 403、他組織の ID を指定すると 404", async () => {
    const asA = { email: `owner-a-${h.suffix}@example.com` };
    const forbidden = await h.request("GET", "/api/v1/agents", { ...asA, org: orgB.id });
    expect(forbidden.status).toBe(403);
    const notFound = await h.request("GET", `/api/v1/agents/${agentB.id}`, { ...asA, org: orgA.id });
    expect(notFound.status).toBe(404);
  });
});
