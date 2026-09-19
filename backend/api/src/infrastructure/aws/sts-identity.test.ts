import { describe, expect, it, vi } from "vitest";
import { STS_GET_CALLER_IDENTITY_BODY, type SignedIdentity } from "@agent-studio/contracts";
import { DevRuntimeIdentityVerifier, StsRuntimeIdentityVerifier, parseAssumedRoleArn } from "./sts-identity.js";

const NOW = new Date("2026-09-19T06:00:00Z");
const ARN = "arn:aws:sts::123456789012:assumed-role/as-sample-a-prod-runtime/abc123";

function identity(overrides: Partial<SignedIdentity> & { headers?: Record<string, string> } = {}): SignedIdentity {
  return {
    method: "POST",
    url: "https://sts.ap-northeast-1.amazonaws.com/",
    body: Buffer.from(STS_GET_CALLER_IDENTITY_BODY).toString("base64"),
    ...overrides,
    headers: {
      host: "sts.ap-northeast-1.amazonaws.com",
      "x-amz-date": "20260919T055930Z",
      "x-agent-studio-server-id": "agent-studio-production",
      authorization:
        "AWS4-HMAC-SHA256 Credential=ASIA.../20260919/ap-northeast-1/sts/aws4_request, SignedHeaders=content-type;host;x-agent-studio-server-id;x-amz-date;x-amz-security-token, Signature=abc",
      ...overrides.headers,
    },
  };
}

const stsOk = () => vi.fn(async () => ({ status: 200, body: `<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>${ARN}</Arn><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>` }));

describe("StsRuntimeIdentityVerifier", () => {
  it("STS の応答から AWS アカウントとロールを特定する", async () => {
    const post = stsOk();
    const v = new StsRuntimeIdentityVerifier("agent-studio-production", post, () => NOW);
    await expect(v.verify(identity())).resolves.toEqual({ accountId: "123456789012", roleName: "as-sample-a-prod-runtime", arn: ARN });
    expect(post).toHaveBeenCalledOnce();
  });

  it.each([
    ["STS 以外への転送", identity({ url: "https://evil.example.com/" })],
    ["クエリ付き URL", identity({ url: "https://sts.amazonaws.com/?Action=GetCallerIdentity" })],
    ["本文の改ざん", identity({ body: Buffer.from("Action=AssumeRole").toString("base64") })],
    ["別の Agent Studio 向けの署名", identity({ headers: { "x-agent-studio-server-id": "agent-studio-staging" } })],
    ["サーバー ID が署名されていない", identity({ headers: { authorization: "AWS4-HMAC-SHA256 Credential=x, SignedHeaders=host;x-amz-date, Signature=abc" } })],
    ["古い署名（リプレイ）", identity({ headers: { "x-amz-date": "20260919T050000Z" } })],
  ])("拒否する: %s", async (_label, id) => {
    const post = stsOk();
    const v = new StsRuntimeIdentityVerifier("agent-studio-production", post, () => NOW);
    await expect(v.verify(id)).rejects.toMatchObject({ code: "invalid_identity" });
    expect(post).not.toHaveBeenCalled();
  });

  it("STS が拒否した署名は受け付けない", async () => {
    const v = new StsRuntimeIdentityVerifier("agent-studio-production", async () => ({ status: 403, body: "SignatureDoesNotMatch" }), () => NOW);
    await expect(v.verify(identity())).rejects.toMatchObject({ code: "invalid_identity" });
  });

  it("IAM ユーザーなどロール以外の身元は受け付けない", async () => {
    const v = new StsRuntimeIdentityVerifier(
      "agent-studio-production",
      async () => ({ status: 200, body: "<Arn>arn:aws:iam::123456789012:user/alice</Arn>" }),
      () => NOW,
    );
    await expect(v.verify(identity())).rejects.toMatchObject({ code: "invalid_identity" });
  });
});

describe("parseAssumedRoleArn", () => {
  it("パスを含まないロール名を取り出す", () => {
    expect(parseAssumedRoleArn(ARN)?.roleName).toBe("as-sample-a-prod-runtime");
    expect(parseAssumedRoleArn("arn:aws:iam::123456789012:role/x")).toBeNull();
  });
});

describe("DevRuntimeIdentityVerifier", () => {
  it("dev://<アカウント>/<ロール>", async () => {
    const v = new DevRuntimeIdentityVerifier();
    await expect(v.verify({ method: "POST", url: "dev://111111111111/as-local-runtime", headers: {}, body: "" })).resolves.toMatchObject({
      accountId: "111111111111",
      roleName: "as-local-runtime",
    });
    await expect(v.verify({ method: "POST", url: "https://sts.amazonaws.com/", headers: {}, body: "" })).rejects.toThrow();
  });
});
