import { describe, expect, it, vi } from "vitest";
import type { Deps } from "../application/deps.js";
import type { ManagedRuntimeProvisioner } from "../infrastructure/aws/managed-runtime-provisioner.js";
import { ManagedRuntimeProvisioningDriver } from "./managed-runtime-provisioning.js";

describe("ManagedRuntimeProvisioningDriver", () => {
  it("アカウント作成から接続完了まで再開可能な段階で進める", async () => {
    const runtime: Record<string, any> = {
      id: "00000000-0000-4000-8000-000000000001",
      organization_id: "00000000-0000-4000-8000-000000000002",
      status: "provisioning",
      provisioning_status: "queued",
      provisioning_account_name: "agent-studio-example-production-abc",
      provisioning_account_email: "aws+example-production-abc@zerotry.dev",
      provisioning_request_id: null,
      provisioning_tenant_short: "example",
      provisioning_outputs: {},
      aws_account_id: null,
      aws_region: "ap-northeast-1",
      stage: "production",
      expected_role_name: "as-example-prod-runtime",
    };
    const tokens: Array<Record<string, unknown>> = [];
    const audits: Array<Record<string, unknown>> = [];
    const tx = {
      runtimes: {
        findFirst: vi.fn(async () => ({ ...runtime })),
        findUnique: vi.fn(async () => ({ ...runtime })),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(runtime, data);
          return { ...runtime };
        }),
      },
      runtime_bootstrap_tokens: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { tokens.push(data); return data; }) },
      audit_logs: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return data; }) },
    };
    const ensureAccount = vi
      .fn<ManagedRuntimeProvisioner["ensureAccount"]>()
      .mockResolvedValueOnce({ status: "pending", requestId: "car-123" })
      .mockResolvedValueOnce({ status: "succeeded", accountId: "123456789012", requestId: "car-123" });
    const provisioner: ManagedRuntimeProvisioner = {
      ensureAccount,
      applyInfrastructure: vi.fn(async () => ({
        bootstrapSecretId: "agent-studio/runtime/example/prod/bootstrap-token",
        clusterName: "as-example-prod",
        runtimeCoreServiceName: "as-example-prod-runtime-core",
        runtimeRoleName: "as-example-prod-runtime",
      })),
      configureBootstrap: vi.fn(async () => undefined),
    };
    const deps = {
      db: { org: async (_organizationId: string, fn: (value: typeof tx) => Promise<unknown>) => fn(tx) },
      managedRuntimeProvisioner: provisioner,
      logger: { error: vi.fn() },
    } as unknown as Deps;
    const driver = new ManagedRuntimeProvisioningDriver(deps, runtime.id, runtime.organization_id);

    await driver.drive();
    expect(runtime.provisioning_status).toBe("account_creating");
    expect(runtime.provisioning_request_id).toBe("car-123");

    await driver.drive();
    expect(runtime.aws_account_id).toBe("123456789012");
    expect(runtime.provisioning_status).toBe("infrastructure_applying");

    await driver.drive();
    expect(runtime.provisioning_status).toBe("bootstrap_configuring");

    await driver.drive();
    expect(runtime.provisioning_status).toBe("connecting");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(provisioner.configureBootstrap).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^asbt_/));

    runtime.status = "active";
    await driver.drive();
    expect(runtime.provisioning_status).toBe("completed");
    expect(runtime.provisioning_progress).toBe(100);
    expect(audits.at(-1)?.action).toBe("runtime.managed_provisioning.complete");
  });
});
