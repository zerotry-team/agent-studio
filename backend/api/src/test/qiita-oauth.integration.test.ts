import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.js";

describe("Qiita OAuth Connection", () => {
  let h: Harness;
  let owner: { email: string; org: string };
  let connectorId: string;

  beforeAll(async () => {
    h = createHarness();
    const email = `qiita-owner-${h.suffix}@example.com`;
    const org = await h.createOrg("qiita-oauth", [{ email, role: "owner" }]);
    owner = { email, org: org.id };
    const connector = await h.request("POST", "/api/v1/connectors", {
      ...owner,
      body: {
        key: "qiita",
        name: "Qiita",
        description: "Qiita記事公開",
        adapter: "http_openapi",
        base_url: "https://qiita.com/api/v2",
        auth_type: "static_bearer",
        operations: [
          {
            name: "publish_qiita_article",
            display_name: "Qiita記事を公開",
            description: "Qiitaへ記事を公開する",
            method: "POST",
            path: "/items",
            risk: "external_send",
            input_schema: { type: "object", properties: {}, additionalProperties: true },
          },
        ],
      },
    });
    expect(connector.status).toBe(201);
    connectorId = connector.body.id;
  });

  afterAll(async () => h.close());

  it("OAuth appと認可tokenをSecret Storeへ保存し、レスポンスやDBへ秘密を出さない", async () => {
    const configured = await h.request("PUT", `/api/v1/connectors/${connectorId}/oauth-app`, {
      ...owner,
      body: { client_id: "client-id", client_secret: "client-secret" },
    });
    expect(configured.status, JSON.stringify(configured.body)).toBe(200);
    expect(configured.body).toMatchObject({ configured: true, client_id: "client-id", has_client_secret: true });
    expect(JSON.stringify(configured.body)).not.toContain("client-secret");
    const connector = await h.admin.connectors.findUniqueOrThrow({ where: { id: connectorId } });
    expect(connector.oauth_client_id).toBe("client-id");
    expect(connector.oauth_client_secret_locator).toBeTruthy();
    expect(Object.values(connector)).not.toContain("client-secret");
    expect(await h.deps.secrets.get(connector.oauth_client_secret_locator!)).toBe("client-secret");

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "qiita-secret-token", scopes: ["read_qiita", "write_qiita"] }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "agent-studio-test" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const connected = await h.request("POST", `/api/v1/connectors/${connectorId}/qiita-oauth/exchange`, {
        ...owner,
        body: { code: "authorization-code" },
      });
      expect(connected.status, JSON.stringify(connected.body)).toBe(201);
      expect(connected.body).toMatchObject({ name: "Qiita (agent-studio-test)", status: "connected", has_secret: true });
      expect(JSON.stringify(connected.body)).not.toContain("qiita-secret-token");

      const stored = await h.admin.connections.findUniqueOrThrow({ where: { id: connected.body.id } });
      expect(stored.secret_locator).toBeTruthy();
      expect(JSON.stringify(stored)).not.toContain("qiita-secret-token");
      expect(await h.deps.secrets.get(stored.secret_locator!)).toBe("qiita-secret-token");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({
        client_id: "client-id",
        client_secret: "client-secret",
        code: "authorization-code",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
