import type { MembershipDto } from "@agent-studio/contracts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * 操作中の組織を決める。Cookie の組織に所属していればそれを、そうでなければ最初の所属組織を使う。
 */
export function resolveActiveMembership(
  memberships: readonly MembershipDto[],
  preferredOrganizationId: string | null | undefined,
): MembershipDto | null {
  if (preferredOrganizationId) {
    const found = memberships.find((m) => m.organization.id === preferredOrganizationId);
    if (found) return found;
  }
  return memberships[0] ?? null;
}
