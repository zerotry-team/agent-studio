"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { switchOrganizationAction } from "@/actions/auth";

/**
 * Cookie の組織が未設定・所属外だったときに、実際に表示している組織を Cookie に保存する。
 * （Server Component の描画中は Cookie を書き換えられないため、画面側から保存する）
 */
export function ActiveOrganizationSync({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    void switchOrganizationAction(organizationId).then((res) => {
      if (res.ok) router.refresh();
    });
  }, [organizationId, router]);
  return null;
}
