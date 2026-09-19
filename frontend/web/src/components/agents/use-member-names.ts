"use client";

import { useCallback } from "react";
import { listMembersAction } from "@/actions/members";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";

/**
 * ユーザー ID を表示名（名前またはメールアドレス）にする。
 * 分からない場合（組織を抜けたメンバーなど）は null を返す。
 */
export function useMemberNames(): (userId: string | null | undefined) => string | null {
  const { organization, me } = useSession();
  const members = useActionQuery(() => listMembersAction(), [organization?.id]);
  const list = members.data;
  const myId = me.user.id;

  return useCallback(
    (userId) => {
      if (!userId) return null;
      if (userId === myId) return "あなた";
      const member = list?.find((m) => m.user_id === userId);
      return member ? (member.display_name ?? member.email) : null;
    },
    [list, myId],
  );
}
