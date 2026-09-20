import type { SetBrowserAccessInput } from "@agent-studio/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

describe("ブラウザ接続範囲の保存と自動デプロイ", () => {
  let h: Harness;
  let owner: { email: string; org: string };
  let builderEmail: string;
  let agentId: string;
  let originalBuildId: string;
  const originalIds: string[] = [];
  const restricted = { access: "restricted", allowed_domains: [] };
  const publicAccess: SetBrowserAccessInput = { access: "public", allowed_domains: [] };

  beforeAll(async () => {
    h = createHarness();
    builderEmail = `browser-builder-${h.suffix}@example.com`;
    const email = `browser-owner-${h.suffix}@example.com`;
    const org = await h.createOrg("browser-save", [{ email, role: "owner" }, { email: builderEmail, role: "builder" }]);
    owner = { email, org: org.id };
    const agent = await h.admin.agents.create({ data: { organization_id: org.id, key: "browser", name: "Browser" } });
    agentId = agent.id;
    const version = await h.admin.agent_versions.create({ data: {
      organization_id: org.id, agent_id: agentId, version: 1, status: "published", manifest: {}, manifest_yaml: "{}",
    } });
    const profile = await h.admin.runtime_profiles.create({ data: { organization_id: org.id, key: "test", name: "Test", type: "openai_hosted" } });
    const base = { organization_id: org.id, agent_id: agentId, agent_version_id: version.id, runtime_profile_id: profile.id };
    const build = await h.admin.agent_builds.create({ data: { ...base, build_number: 1, compiled_config: { browser_access: restricted, instructions: "keep instructions" } } });
    originalBuildId = build.id;
    for (const stage of ["staging", "production"]) {
      const deployment = await h.admin.deployments.create({ data: {
        ...base, build_id: build.id, stage,
        compiled_config: { browser_access: restricted, instructions: "keep instructions", variables: { STAGE: stage } },
      } });
      originalIds.push(deployment.id);
    }
  });
  afterAll(async () => h.close());

  const save = (access: SetBrowserAccessInput = publicAccess, email?: string) => h.request("PUT", `/api/v1/agents/${agentId}/browser-access`, {
    ...owner, ...(email ? { email } : {}), body: access,
  });
  const active = () => h.admin.deployments.findMany({ where: { agent_id: agentId, status: "active" }, include: { build: true } });

  it("本番公開後はbuilderによる保存を拒否し、設定もデプロイも変更しない", async () => {
    expect((await save(publicAccess, builderEmail)).status).toBe(403);
    expect((await h.admin.agents.findUniqueOrThrow({ where: { id: agentId } })).browser_access).toBe("restricted");
    expect((await active()).map((d) => d.id).sort()).toEqual([...originalIds].sort());
  });

  it("保存するとPreview・本番を置き換え、古いBuildとデプロイの設定を維持する", async () => {
    const response = await save();
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const deployments = await active();
    expect(deployments).toHaveLength(2);
    for (const d of deployments) {
      expect(originalIds).not.toContain(d.id);
      expect(d.compiled_config).toEqual({ browser_access: publicAccess, instructions: "keep instructions", variables: { STAGE: d.stage } });
      expect(d.build?.compiled_config).toEqual({ browser_access: publicAccess, instructions: "keep instructions" });
      expect(d.build_id).not.toBe(originalBuildId);
    }
    expect(new Set(deployments.map((d) => d.build_id)).size).toBe(1);
    const old = await h.admin.deployments.findMany({ where: { id: { in: originalIds } } });
    expect(old.every((d) => d.status === "superseded")).toBe(true);
    for (const d of old) expect(d.compiled_config).toMatchObject({ browser_access: restricted });
    expect((await h.admin.agent_builds.findUniqueOrThrow({ where: { id: originalBuildId } })).compiled_config).toMatchObject({ browser_access: restricted });
  });

  it("同じ設定の再保存ではデプロイを増やさない", async () => {
    const before = (await active()).map((d) => d.id).sort();
    expect((await save()).status).toBe(200);
    expect((await active()).map((d) => d.id).sort()).toEqual(before);
  });

  it("許可ドメインの制限も両環境の次回実行設定に反映する", async () => {
    const setting: SetBrowserAccessInput = { access: "restricted", allowed_domains: ["qiita.com"] };
    expect((await save(setting)).status).toBe(200);
    for (const d of await active()) expect(d.compiled_config).toMatchObject({ browser_access: setting });
  });
});
