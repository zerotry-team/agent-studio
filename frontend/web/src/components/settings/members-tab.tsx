"use client";

import type { MemberDto, MemberRole } from "@agent-studio/contracts";
import { Trash2, UserPlus, Users } from "lucide-react";
import { useState } from "react";
import { listMembersAction, removeMemberAction, updateMemberAction } from "@/actions/members";
import { QueryView } from "@/components/common/query-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/input";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import { formatDateTime } from "@/lib/utils/format";
import { ROLE_LABELS } from "@/lib/utils/labels";
import { assignableRoles, canManageMember } from "@/lib/utils/permissions";
import { InviteMemberDialog } from "./invite-member-dialog";
import { RoleLegend } from "./role-legend";

function memberName(member: MemberDto): string {
  return member.display_name?.trim() || member.email;
}

const ROLE_ORDER: Record<MemberRole, number> = { owner: 0, admin: 1, builder: 2, operator: 3, viewer: 4 };

function sortMembers(members: readonly MemberDto[]): MemberDto[] {
  return [...members].sort(
    (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || memberName(a).localeCompare(memberName(b), "ja"),
  );
}

export function MembersTab() {
  const { me, organization, access, can } = useSession();
  const canManage = can("member.manage");
  const roles = assignableRoles(access);
  const query = useActionQuery(() => listMembersAction(), [organization?.id]);
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<MemberDto | null>(null);
  /** 変更中のメンバー（user_id）と項目 */
  const [updating, setUpdating] = useState<{ userId: string; field: "role" | "is_approver" } | null>(null);

  const updateRole = useActionMutation(updateMemberAction, {
    successMessage: (m) => `${memberName(m)} の権限を「${ROLE_LABELS[m.role]}」に変更しました`,
  });
  const updateApprover = useActionMutation(updateMemberAction, {
    successMessage: (m) => (m.is_approver ? `${memberName(m)} を承認者にしました` : `${memberName(m)} を承認者から外しました`),
  });
  const remove = useActionMutation(removeMemberAction, { successMessage: "メンバーを削除しました" });

  const replaceMember = (member: MemberDto) => {
    query.setData((prev) => prev?.map((m) => (m.user_id === member.user_id ? member : m)));
  };

  const changeRole = async (member: MemberDto, role: MemberRole) => {
    if (role === member.role) return;
    setUpdating({ userId: member.user_id, field: "role" });
    const res = await updateRole.mutate(member.user_id, { role });
    setUpdating(null);
    if (res.ok) replaceMember(res.data);
  };

  const changeApprover = async (member: MemberDto, isApprover: boolean) => {
    setUpdating({ userId: member.user_id, field: "is_approver" });
    const res = await updateApprover.mutate(member.user_id, { is_approver: isApprover });
    setUpdating(null);
    if (res.ok) replaceMember(res.data);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="メンバー"
          description="この組織に所属しているメンバーと、それぞれの権限です。"
          actions={
            canManage && roles.length > 0 ? (
              <Button onClick={() => setInviting(true)} icon={<UserPlus className="h-4 w-4" aria-hidden="true" />}>
                メンバーを招待
              </Button>
            ) : null
          }
        />
        <QueryView
          query={query}
          compactError
          loading={<TableSkeleton rows={4} columns={canManage ? 5 : 4} />}
          isEmpty={(members) => members.length === 0}
          empty={
            <EmptyState
              icon={Users}
              title="メンバーがいません"
              description={canManage ? "「メンバーを招待」から、一緒に使う人を追加してください。" : undefined}
            />
          }
        >
          {(members) => (
            <Table>
              <THead>
                <tr>
                  <TH>メンバー</TH>
                  <TH>権限</TH>
                  <TH>承認者</TH>
                  <TH className="hidden md:table-cell">参加日</TH>
                  {canManage ? (
                    <TH>
                      <span className="sr-only">操作</span>
                    </TH>
                  ) : null}
                </tr>
              </THead>
              <TBody>
                {sortMembers(members).map((member) => {
                  const isMe = member.user_id === me.user.id;
                  const manageable = canManageMember(access, member.role);
                  const name = memberName(member);
                  const busyRole = updating?.userId === member.user_id && updating.field === "role";
                  const busyApprover = updating?.userId === member.user_id && updating.field === "is_approver";
                  const selfNoteId = `member-self-note-${member.user_id}`;
                  return (
                    <TR key={member.user_id}>
                      <TD className="min-w-[12rem] max-w-[18rem]">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium text-gray-900">{name}</span>
                          {isMe ? <Badge tone="accent">あなた</Badge> : null}
                        </div>
                        {member.display_name ? <span className="block truncate text-xs text-gray-500">{member.email}</span> : null}
                      </TD>
                      <TD>
                        {manageable && !isMe ? (
                          <div className="w-36">
                            <Select
                              aria-label={`${name} の権限`}
                              value={member.role}
                              disabled={busyRole}
                              onChange={(e) => void changeRole(member, e.target.value as MemberRole)}
                            >
                              {roles.map((r) => (
                                <option key={r} value={r}>
                                  {ROLE_LABELS[r]}
                                </option>
                              ))}
                            </Select>
                          </div>
                        ) : (
                          <span className="whitespace-nowrap text-gray-800">{ROLE_LABELS[member.role]}</span>
                        )}
                      </TD>
                      <TD>
                        {manageable ? (
                          <Switch
                            label={`${name} を承認者にする`}
                            checked={member.is_approver}
                            disabled={busyApprover}
                            onChange={(checked) => void changeApprover(member, checked)}
                          />
                        ) : member.is_approver ? (
                          <Badge tone="success">承認者</Badge>
                        ) : (
                          <>
                            <span className="text-gray-400" aria-hidden="true">
                              —
                            </span>
                            <span className="sr-only">なし</span>
                          </>
                        )}
                      </TD>
                      <TD className="hidden whitespace-nowrap text-gray-500 md:table-cell">{formatDateTime(member.created_at)}</TD>
                      {canManage ? (
                        <TD className="text-right">
                          {manageable ? (
                            isMe ? (
                              <>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled
                                  aria-describedby={selfNoteId}
                                  title="自分自身は削除できません"
                                  icon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
                                >
                                  削除
                                </Button>
                                <span id={selfNoteId} className="sr-only">
                                  自分自身は削除できません。ほかの管理者に依頼してください。
                                </span>
                              </>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-red-700 hover:bg-red-50"
                                onClick={() => setRemoving(member)}
                                aria-label={`${name} を削除`}
                                icon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
                              >
                                削除
                              </Button>
                            )
                          ) : null}
                        </TD>
                      ) : null}
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </QueryView>
        {canManage ? (
          <p className="border-t border-gray-100 px-5 py-3 text-xs leading-relaxed text-gray-500">
            自分自身の権限の変更と削除は、この画面からはできません。オーナーの権限を変更・削除できるのはオーナーだけです。
          </p>
        ) : null}
      </Card>

      <Card>
        <CardBody>
          <RoleLegend />
        </CardBody>
      </Card>

      {inviting ? (
        <InviteMemberDialog
          roles={roles}
          onClose={() => setInviting(false)}
          onInvited={(member) => query.setData((prev) => (prev ? [...prev.filter((m) => m.user_id !== member.user_id), member] : [member]))}
        />
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="メンバーを削除しますか？"
        description={
          removing
            ? `${memberName(removing)}（${removing.email}）は、この組織を使えなくなります。これまでの実行履歴や監査ログの記録は残ります。`
            : undefined
        }
        confirmLabel="削除する"
        onConfirm={async () => {
          if (!removing) return;
          const target = removing;
          const res = await remove.mutate(target.user_id);
          if (!res.ok) return false;
          query.setData((prev) => prev?.filter((m) => m.user_id !== target.user_id));
          return undefined;
        }}
      />
    </div>
  );
}
