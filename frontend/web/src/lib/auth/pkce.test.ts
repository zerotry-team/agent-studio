import { describe, expect, it } from "vitest";
import {
  base64UrlEncode,
  buildAuthorizeUrl,
  createCodeChallenge,
  createCodeVerifier,
  createState,
  sanitizeReturnTo,
  timingSafeEqual,
} from "./pkce";

describe("PKCE helpers", () => {
  it("computes the S256 challenge from RFC 7636 Appendix B", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await createCodeChallenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("creates verifiers of valid length and charset", () => {
    const verifier = createCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(createCodeVerifier()).not.toBe(verifier);
    expect(createState()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("base64url-encodes without padding", () => {
    expect(base64UrlEncode(new Uint8Array([251, 255]))).toBe("-_8");
  });

  it("builds the Cognito authorize URL", () => {
    const url = new URL(
      buildAuthorizeUrl({
        domain: "https://example.auth.ap-northeast-1.amazoncognito.com/",
        clientId: "client123",
        redirectUri: "https://studio.example.com/auth/callback",
        state: "state-1",
        codeChallenge: "challenge-1",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://example.auth.ap-northeast-1.amazoncognito.com/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://studio.example.com/auth/callback");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.search).toContain("scope=openid+email+profile");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("only allows same-origin relative return paths", () => {
    expect(sanitizeReturnTo("/runs/abc?x=1")).toBe("/runs/abc?x=1");
    expect(sanitizeReturnTo(null)).toBe("/");
    expect(sanitizeReturnTo("https://evil.example")).toBe("/");
    expect(sanitizeReturnTo("//evil.example")).toBe("/");
    expect(sanitizeReturnTo("/\\evil.example")).toBe("/");
    expect(sanitizeReturnTo("/auth/login")).toBe("/");
  });

  it("compares strings in constant time", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});
