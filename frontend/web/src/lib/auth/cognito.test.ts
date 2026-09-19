import { describe, expect, it, vi } from "vitest";
import {
  buildLogoutUrl,
  callbackUrl,
  CognitoTokenError,
  exchangeAuthorizationCode,
  refreshIdToken,
  sessionFromTokenResponse,
  type CognitoSettings,
} from "./cognito";

const settings: CognitoSettings = {
  domain: "https://example.auth.ap-northeast-1.amazoncognito.com",
  clientId: "client123",
  clientSecret: "secret456",
  appBaseUrl: "https://studio.example.com/",
};

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(claims)}.sig`;
}

describe("cognito helpers", () => {
  it("exchanges the authorization code with HTTP Basic client auth and PKCE verifier", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ id_token: jwt({ exp: 2_000_000_000 }), refresh_token: "r1", expires_in: 3600 }),
    );
    const tokens = await exchangeAuthorizationCode(settings, { code: "code-1", codeVerifier: "verifier-1" }, fetchMock);
    expect(tokens.refresh_token).toBe("r1");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://example.auth.ap-northeast-1.amazoncognito.com/oauth2/token");
    const headers = init!.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from("client123:secret456").toString("base64")}`);
    const body = new URLSearchParams(String(init!.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code-1");
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("redirect_uri")).toBe("https://studio.example.com/auth/callback");
  });

  it("throws CognitoTokenError when the token endpoint fails", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
    await expect(refreshIdToken(settings, "r1", fetchMock)).rejects.toBeInstanceOf(CognitoTokenError);
    await expect(refreshIdToken(settings, "r1", fetchMock)).rejects.toMatchObject({ status: 400, oauthError: "invalid_grant" });
  });

  it("builds a session using the id token exp and keeps the previous refresh token", () => {
    const s = sessionFromTokenResponse({ id_token: jwt({ exp: 1_999_999_999, email: "a@b.example" }), expires_in: 60 }, "old-refresh", 1000);
    expect(s).toEqual({ id_token: expect.any(String), refresh_token: "old-refresh", expires_at: 1_999_999_999, email: "a@b.example" });
  });

  it("falls back to expires_in when the id token cannot be decoded", () => {
    const s = sessionFromTokenResponse({ id_token: "opaque", expires_in: 60, refresh_token: "new" }, "old", 1000);
    expect(s.expires_at).toBe(1060);
    expect(s.refresh_token).toBe("new");
  });

  it("builds callback and logout URLs from APP_BASE_URL", () => {
    expect(callbackUrl(settings)).toBe("https://studio.example.com/auth/callback");
    const logout = new URL(buildLogoutUrl(settings));
    expect(logout.origin + logout.pathname).toBe("https://example.auth.ap-northeast-1.amazoncognito.com/logout");
    expect(logout.searchParams.get("client_id")).toBe("client123");
    expect(logout.searchParams.get("logout_uri")).toBe("https://studio.example.com/");
  });
});
