import { describe, expect, it, vi } from "vitest";
import { ApiClient, buildQueryString, requiresOrganizationHeader } from "./client";
import { ApiError, UNAVAILABLE_MESSAGE } from "./errors";

const ORG_ID = "11111111-2222-4333-8444-555555555555";

function setup(response: Response | (() => Promise<Response>), organizationId: string | null = ORG_ID) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    typeof response === "function" ? response() : response.clone(),
  );
  const getOrganizationId = vi.fn(async () => organizationId);
  const client = new ApiClient({
    baseUrl: "http://api.internal:3200/",
    getToken: async () => "id-token-123",
    getOrganizationId,
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, fetchMock, getOrganizationId };
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return init?.headers as Record<string, string>;
}

describe("ApiClient", () => {
  it("sends the bearer token and x-organization-id to organization APIs", async () => {
    const { client, fetchMock } = setup(Response.json([{ id: "a1" }]));
    const data = await client.get<{ id: string }[]>("/agents");
    expect(data).toEqual([{ id: "a1" }]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.internal:3200/api/v1/agents");
    expect(headersOf(init).authorization).toBe("Bearer id-token-123");
    expect(headersOf(init)["x-organization-id"]).toBe(ORG_ID);
    expect(init?.cache).toBe("no-store");
  });

  it("does not send x-organization-id to /me and /admin/*", async () => {
    const { client, fetchMock, getOrganizationId } = setup(Response.json({}));
    await client.get("/me");
    await client.post("/admin/organizations", { slug: "x" });
    expect(getOrganizationId).not.toHaveBeenCalled();
    for (const [, init] of fetchMock.mock.calls) {
      expect(headersOf(init)["x-organization-id"]).toBeUndefined();
    }
  });

  it("serializes JSON bodies and query strings", async () => {
    const { client, fetchMock } = setup(Response.json({ ok: true }));
    await client.post("/runs", { deployment_id: "d1", input: "こんにちは" });
    await client.get("/runs", { deployment_id: "d1", limit: 50, before: undefined });
    const [, postInit] = fetchMock.mock.calls[0]!;
    expect(headersOf(postInit)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(postInit?.body))).toEqual({ deployment_id: "d1", input: "こんにちは" });
    expect(fetchMock.mock.calls[1]![0]).toBe("http://api.internal:3200/api/v1/runs?deployment_id=d1&limit=50");
  });

  it("maps ApiErrorBody to ApiError with the Japanese message and code", async () => {
    const body = { error: { code: "forbidden", message: "この操作には管理者の権限が必要です", details: [{ path: "name", message: "必須です" }] } };
    const { client } = setup(Response.json(body, { status: 403 }));
    const error = await client.delete("/connections/c1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "forbidden", message: "この操作には管理者の権限が必要です" });
    expect((error as ApiError).fieldErrors).toEqual({ name: "必須です" });
  });

  it("uses a Japanese default message when the error body is not ApiErrorBody", async () => {
    const { client } = setup(new Response("<html>Bad Gateway</html>", { status: 502 }));
    const error = (await client.get("/agents").catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("internal");
    expect(error.message).toMatch(/サーバーでエラーが発生しました/);

    const { client: c404 } = setup(new Response(null, { status: 404 }));
    await expect(c404.get("/agents/x")).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("maps network failures to an 'unavailable' ApiError", async () => {
    const { client } = setup(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(client.get("/agents")).rejects.toMatchObject({ code: "unavailable", status: 0, message: UNAVAILABLE_MESSAGE });
  });

  it("returns undefined for 204 / 202 responses", async () => {
    const { client } = setup(new Response(null, { status: 204 }));
    await expect(client.delete("/policies/p1")).resolves.toBeUndefined();
    const { client: c202 } = setup(new Response(null, { status: 202 }));
    await expect(c202.post("/runs/r1/messages", { input: "続けて" })).resolves.toBeUndefined();
  });

  it("fails before calling the API when no organization is selected", async () => {
    const { client, fetchMock } = setup(Response.json([]), null);
    await expect(client.get("/agents")).rejects.toMatchObject({ code: "no_organization" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("knows which paths need the organization header", () => {
    expect(requiresOrganizationHeader("/me")).toBe(false);
    expect(requiresOrganizationHeader("/me?x=1")).toBe(false);
    expect(requiresOrganizationHeader("/admin/organizations")).toBe(false);
    expect(requiresOrganizationHeader("/members")).toBe(true);
    expect(requiresOrganizationHeader("/administrators")).toBe(true);
  });

  it("builds query strings without empty values", () => {
    expect(buildQueryString({ a: "1", b: undefined, c: null, d: "", e: 0 })).toBe("?a=1&e=0");
    expect(buildQueryString({})).toBe("");
  });
});
