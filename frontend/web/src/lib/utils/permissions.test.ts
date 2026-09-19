import { describe, expect, it } from "vitest";
import { assignableRoles, can, canDeployTo, canManageMember, visibleNavItems, type AccessContext } from "./permissions";

const ctx = (role: AccessContext["role"], isApprover = false, isPlatformAdmin = false): AccessContext => ({
  role,
  isApprover,
  isPlatformAdmin,
});

describe("can", () => {
  it("follows the role order viewer < operator < builder < admin < owner", () => {
    expect(can(ctx("viewer"), "view")).toBe(true);
    expect(can(ctx("viewer"), "run.start")).toBe(false);
    expect(can(ctx("operator"), "run.start")).toBe(true);
    expect(can(ctx("operator"), "agent.edit")).toBe(false);
    expect(can(ctx("builder"), "agent.edit")).toBe(true);
    expect(can(ctx("builder"), "connection.manage")).toBe(false);
    expect(can(ctx("admin"), "connection.manage")).toBe(true);
    expect(can(ctx("admin"), "audit.view")).toBe(true);
    expect(can(ctx("admin"), "runtime.revoke")).toBe(false);
    expect(can(ctx("admin"), "openai.view")).toBe(true);
    expect(can(ctx("admin"), "openai.edit")).toBe(false);
    expect(can(ctx("owner"), "runtime.revoke")).toBe(true);
    expect(can(ctx("owner"), "organization.edit")).toBe(true);
  });

  it("treats approval as a flag independent of the role", () => {
    expect(can(ctx("viewer", true), "approval.decide")).toBe(true);
    expect(can(ctx("owner", false), "approval.decide")).toBe(false);
    expect(can(ctx(null, true), "approval.decide")).toBe(false);
  });

  it("denies everything organization-scoped without a membership", () => {
    expect(can(ctx(null), "view")).toBe(false);
    expect(can(ctx(null, false, true), "platform.admin")).toBe(true);
    expect(can(ctx("owner"), "platform.admin")).toBe(false);
  });
});

describe("deployment and member rules", () => {
  it("requires admin for production deployments", () => {
    expect(canDeployTo(ctx("builder"), "staging")).toBe(true);
    expect(canDeployTo(ctx("builder"), "production")).toBe(false);
    expect(canDeployTo(ctx("admin"), "production")).toBe(true);
  });

  it("lets only owners grant or change the owner role", () => {
    expect(assignableRoles(ctx("builder"))).toEqual([]);
    expect(assignableRoles(ctx("admin"))).not.toContain("owner");
    expect(assignableRoles(ctx("owner"))).toContain("owner");
    expect(canManageMember(ctx("admin"), "owner")).toBe(false);
    expect(canManageMember(ctx("admin"), "builder")).toBe(true);
    expect(canManageMember(ctx("owner"), "owner")).toBe(true);
  });
});

describe("visibleNavItems", () => {
  it("hides admin-only items from lower roles", () => {
    const labels = (role: AccessContext["role"]) => visibleNavItems(ctx(role)).map((i) => i.href);
    expect(labels("viewer")).not.toContain("/audit-logs");
    expect(labels("viewer")).not.toContain("/usage");
    expect(labels("viewer")).toContain("/approvals");
    expect(labels("admin")).toContain("/audit-logs");
    expect(labels("admin")).toContain("/usage");
    expect(labels(null)).toEqual([]);
  });
});
