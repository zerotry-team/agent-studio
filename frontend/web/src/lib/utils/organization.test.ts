import type { MembershipDto } from "@agent-studio/contracts";
import { describe, expect, it } from "vitest";
import { isUuid, resolveActiveMembership } from "./organization";

const membership = (id: string): MembershipDto => ({
  organization: { id, slug: id.slice(0, 4), name: id, status: "active", created_at: "2026-01-01T00:00:00Z" },
  role: "viewer",
  is_approver: false,
});

describe("resolveActiveMembership", () => {
  const a = membership("aaaaaaaa-0000-4000-8000-000000000001");
  const b = membership("bbbbbbbb-0000-4000-8000-000000000002");

  it("uses the cookie organization when the user belongs to it", () => {
    expect(resolveActiveMembership([a, b], b.organization.id)).toBe(b);
  });

  it("falls back to the first membership otherwise", () => {
    expect(resolveActiveMembership([a, b], "cccccccc-0000-4000-8000-000000000003")).toBe(a);
    expect(resolveActiveMembership([a, b], null)).toBe(a);
    expect(resolveActiveMembership([], a.organization.id)).toBeNull();
  });

  it("validates UUIDs", () => {
    expect(isUuid(a.organization.id)).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
