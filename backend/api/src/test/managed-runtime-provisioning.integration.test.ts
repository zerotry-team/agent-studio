import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

describe("Studio-managed Runtime provisioning API", () => {
  let h: Harness;
  const email = "managed-runtime-admin@example.com";
  let organizationId: string;

  beforeAll(async () => {
    h = createHarness({}, {
      MANAGED_RUNTIME_PROVISIONING_ROLE_ARN: "arn:aws:iam::123456789012:role/ManagedRuntimeTest",
      MANAGED_RUNTIME_STATE_BUCKET: "managed-runtime-test-state",
      MANAGED_RUNTIME_IMAGE_REGISTRY: "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com",
      MANAGED_RUNTIME_IMAGE_TAG: "test",
    });
    organizationId = (await h.createOrg("managed-runtime", [{ email, role: "admin" }])).id;
  });

  afterAll(async () => h.close());

  it("AWSアカウント情報なしでprofileと構築待ちRuntimeを一括作成する", async () => {
    const response = await h.request("POST", "/api/v1/managed-runtime-environments", {
      email,
      org: organizationId,
      body: {
        key: "production-managed",
        name: "本番環境",
        runtime_name: "本番 Managed Runtime",
        stage: "production",
        aws_region: "ap-northeast-1",
      },
    });

    expect(response.status).toBe(202);
    expect(response.body.profile.key).toBe("production-managed");
    expect(response.body.runtime).toMatchObject({
      provisioning_type: "studio_managed",
      status: "provisioning",
      aws_account_id: null,
      provisioning: { status: "queued", progress: 5, can_retry: false },
    });
    const stored = await h.admin.runtime_profiles.findFirstOrThrow({
      where: { organization_id: organizationId, key: "production-managed" },
      include: { runtime: true },
    });
    expect(stored.runtime?.id).toBe(response.body.runtime.id);
    expect(stored.runtime?.provisioning_account_email).toMatch(/^aws\+.+@zerotry\.dev$/);
  });
});
