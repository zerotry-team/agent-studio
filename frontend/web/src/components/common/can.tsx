"use client";

import type { ReactNode } from "react";
import { useSession } from "@/hooks/use-session";
import type { Capability } from "@/lib/utils/permissions";

/** 権限がある場合だけ中身を表示する（最終的な判定は API サーバーが行う） */
export function Can({ capability, children, fallback = null }: { capability: Capability; children: ReactNode; fallback?: ReactNode }) {
  const { can } = useSession();
  return <>{can(capability) ? children : fallback}</>;
}
