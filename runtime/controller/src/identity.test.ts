import { RUNTIME_SERVER_ID_HEADER, STS_GET_CALLER_IDENTITY_BODY, signedIdentitySchema } from "@agent-studio/contracts";
import { describe, expect, it } from "vitest";
import { createAwsIdentitySigner, createDevIdentitySigner, stsHostname } from "./identity.js";

const credentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  sessionToken: "session-token-example",
};
const now = () => new Date("2026-09-19T06:00:00Z");

const signedHeaders = (authorization: string | undefined) =>
  /SignedHeaders=([^,\s]+)/.exec(authorization ?? "")?.[1]?.split(";") ?? [];

describe("createAwsIdentitySigner", () => {
  const sign = createAwsIdentitySigner({ region: "ap-northeast-1", serverId: "agent-studio-staging", credentials, now });

  it("STS への署名済み GetCallerIdentity を契約どおりの形で返す", async () => {
    const identity = await sign();
    expect(signedIdentitySchema.safeParse(identity).success).toBe(true);
    expect(identity.method).toBe("POST");
    expect(identity.url).toBe("https://sts.ap-northeast-1.amazonaws.com/");
    expect(Buffer.from(identity.body, "base64").toString("utf8")).toBe(STS_GET_CALLER_IDENTITY_BODY);
    expect(identity.headers.host).toBe("sts.ap-northeast-1.amazonaws.com");
    expect(identity.headers["content-type"]).toBe("application/x-www-form-urlencoded; charset=utf-8");
    expect(identity.headers["x-amz-date"]).toBe("20260919T060000Z");
    expect(identity.headers["x-amz-security-token"]).toBe("session-token-example");
    expect(identity.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260919\/ap-northeast-1\/sts\/aws4_request, SignedHeaders=/,
    );
  });

  it("Agent Studio 固有のヘッダ（サーバー ID）を署名対象に含める", async () => {
    const identity = await sign();
    expect(identity.headers[RUNTIME_SERVER_ID_HEADER]).toBe("agent-studio-staging");
    const signed = signedHeaders(identity.headers.authorization);
    expect(signed).toContain(RUNTIME_SERVER_ID_HEADER);
    expect(signed).toContain("host");
    expect(signed).toContain("x-amz-date");
    expect(signed).toContain("x-amz-security-token");
  });

  it("サーバー ID が違えば署名も変わる（他の Agent Studio 向けに流用できない）", async () => {
    const other = createAwsIdentitySigner({ region: "ap-northeast-1", serverId: "agent-studio-production", credentials, now });
    const a = (await sign()).headers.authorization;
    const b = (await other()).headers.authorization;
    expect(a).not.toBe(b);
    // 同じ入力なら同じ署名
    expect((await sign()).headers.authorization).toBe(a);
  });

  it("中国リージョンのエンドポイント", () => {
    expect(stsHostname("cn-north-1")).toBe("sts.cn-north-1.amazonaws.com.cn");
  });
});

describe("createDevIdentitySigner", () => {
  it("dev://<アカウントID>/<ロール名> を返す", async () => {
    const identity = await createDevIdentitySigner("123456789012", "as-sample-a-prod-runtime")();
    expect(identity).toEqual({ method: "POST", url: "dev://123456789012/as-sample-a-prod-runtime", headers: {}, body: "" });
    expect(signedIdentitySchema.safeParse(identity).success).toBe(true);
  });
});
