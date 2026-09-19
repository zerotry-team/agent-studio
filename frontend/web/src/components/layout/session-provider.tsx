"use client";

import type { MeDto, MembershipDto, OrganizationDto, Stage } from "@agent-studio/contracts";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { can, canDeployTo, type AccessContext, type Capability } from "@/lib/utils/permissions";

export interface SessionContextValue {
  me: MeDto;
  /** 操作中の組織での所属（所属が無い場合は null） */
  membership: MembershipDto | null;
  organization: OrganizationDto | null;
  access: AccessContext;
  can: (capability: Capability) => boolean;
  canDeployTo: (stage: Stage) => boolean;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({
  me,
  activeOrganizationId,
  children,
}: {
  me: MeDto;
  activeOrganizationId: string | null;
  children: ReactNode;
}) {
  const value = useMemo<SessionContextValue>(() => {
    const membership = me.memberships.find((m) => m.organization.id === activeOrganizationId) ?? null;
    const access: AccessContext = {
      role: membership?.role ?? null,
      isApprover: membership?.is_approver ?? false,
      isPlatformAdmin: me.user.is_platform_admin,
    };
    return {
      me,
      membership,
      organization: membership?.organization ?? null,
      access,
      can: (capability) => can(access, capability),
      canDeployTo: (stage) => canDeployTo(access, stage),
    };
  }, [me, activeOrganizationId]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** ログイン中のユーザー・操作中の組織・権限 */
export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession は SessionProvider の中で使ってください");
  return ctx;
}
