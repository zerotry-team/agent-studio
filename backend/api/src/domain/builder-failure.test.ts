import { describe, expect, it } from "vitest";
import { builderRetryDelayMs, classifyBuilderFailure } from "./builder-failure.js";

describe("Builder failure policy", () => {
  it.each([
    ["Runtime heartbeatが途絶えました", "runtime_unavailable", true],
    ["GitHub pull request required checks failed", "git_delivery_failed", true],
    ["Production限定Runに失敗しました", "production_failed", false],
    ["組織Policyで拒否されました", "policy_denied", false],
    ["予期しないcompile error", "build_failed", true],
  ] as const)("%sを分類する", (message, failureClass, retryable) => {
    expect(classifyBuilderFailure(new Error(message))).toMatchObject({ failureClass, retryable });
  });

  it("可変IDを正規化して同じ失敗を同じfingerprintにする", () => {
    const first = classifyBuilderFailure(new Error("Runtime 11111111-1111-4111-8111-111111111111 offline"));
    const second = classifyBuilderFailure(new Error("Runtime 22222222-2222-4222-8222-222222222222 offline"));
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("attemptごとに上限付きbackoffを返す", () => {
    const policy = classifyBuilderFailure(new Error("Runtime offline"));
    expect(builderRetryDelayMs(policy, 1)).toBe(15_000);
    expect(builderRetryDelayMs(policy, 2)).toBe(60_000);
    expect(builderRetryDelayMs(policy, 10)).toBe(60_000);
  });
});
