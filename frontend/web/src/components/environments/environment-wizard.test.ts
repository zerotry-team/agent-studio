import { describe, expect, it } from "vitest";
import { initialWizardState, validateWizard } from "./environment-wizard";

describe("validateWizard", () => {
  it("Studio管理AWSではAWSアカウントIDとIAMロールを利用者に要求しない", () => {
    const result = validateWizard({
      ...initialWizardState(),
      choice: "studio_managed",
      name: "本番環境",
      key: "production",
      runtimeName: "本番 Runtime",
      stage: "production",
      awsRegion: "ap-northeast-1",
      awsAccountId: "",
      roleName: "",
    });

    expect(result.errors).toEqual({});
    expect(result.submission).toEqual({
      kind: "managed",
      input: {
        key: "production",
        name: "本番環境",
        runtime_name: "本番 Runtime",
        stage: "production",
        aws_region: "ap-northeast-1",
      },
    });
  });

  it("自社AWSではAWSアカウントIDとIAMロールを引き続き要求する", () => {
    const result = validateWizard({
      ...initialWizardState(),
      choice: "customer_owned",
      name: "自社AWS",
      key: "customer-aws",
      runtimeName: "自社 Runtime",
    });

    expect(result.submission).toBeNull();
    expect(result.errors["runtime.aws_account_id"]).toBeTruthy();
    expect(result.errors["runtime.expected_role_name"]).toBeTruthy();
  });
});
