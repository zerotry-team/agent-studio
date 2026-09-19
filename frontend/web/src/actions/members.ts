"use server";

import type { InviteMemberInput, UpdateMemberInput } from "@agent-studio/contracts";
import { runAction } from "@/lib/api/run-action";
import {
  InviteMemberService,
  ListMembersService,
  RemoveMemberService,
  UpdateMemberService,
} from "@/lib/services/members";

export async function listMembersAction() {
  return runAction(() => new ListMembersService().invoke(), "メンバーの一覧を取得できませんでした");
}

export async function inviteMemberAction(input: InviteMemberInput) {
  return runAction(() => new InviteMemberService().invoke(input), "メンバーを招待できませんでした");
}

export async function updateMemberAction(userId: string, input: UpdateMemberInput) {
  return runAction(() => new UpdateMemberService().invoke(userId, input), "メンバーの権限を変更できませんでした");
}

export async function removeMemberAction(userId: string) {
  return runAction(() => new RemoveMemberService().invoke(userId), "メンバーを削除できませんでした");
}
