"use client";

import type { RuntimeDto, RuntimeProfileDto } from "@agent-studio/contracts";
import { Layers, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { deleteRuntimeProfileAction } from "@/actions/environments";
import { QueryView } from "@/components/common/query-view";
import { RuntimeStatusBadge, StageBadge } from "@/components/common/status-badges";
import { TimeAgo } from "@/components/common/time-ago";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { ActionQuery } from "@/hooks/use-action-query";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { NETWORK_MODE_LABELS, OPENAI_TEMPLATE_LABELS, PROFILE_TYPE_LABELS } from "@/lib/utils/labels";

export interface RuntimeProfilesCardProps {
  query: ActionQuery<RuntimeProfileDto[]>;
  /** Runtime の最新の状態（プロファイルに含まれる状態より新しい） */
  runtimes: RuntimeDto[] | undefined;
  canManage: boolean;
  createAction: ReactNode;
}

/** 実行環境の設定（プロファイル）の一覧 */
export function RuntimeProfilesCard({ query, runtimes, canManage, createAction }: RuntimeProfilesCardProps) {
  const [deleting, setDeleting] = useState<RuntimeProfileDto | null>(null);
  const remove = useActionMutation(deleteRuntimeProfileAction, { successMessage: "実行環境を削除しました" });

  return (
    <Card>
      <CardHeader
        title="実行環境"
        description="エージェントをどこで実行するかの設定です。エージェントの定義（environment.profile）やデプロイのときに、キーで選びます。"
      />
      <QueryView
        query={query}
        compactError
        loading={<TableSkeleton rows={3} columns={4} />}
        isEmpty={(items) => items.length === 0}
        empty={
          <EmptyState
            icon={Layers}
            title="実行環境はまだありません"
            description={
              canManage
                ? "エージェントをどこで実行するかを設定します。OpenAI の環境なら、すぐに使い始められます。"
                : "実行環境が作られると、ここに表示されます。実行環境の作成は管理者が行います。"
            }
            action={createAction}
          />
        }
      >
        {(profiles) => (
          <Table>
            <THead>
              <tr>
                <TH>名前</TH>
                <TH>実行場所</TH>
                <TH className="hidden sm:table-cell">作成</TH>
                {canManage ? (
                  <TH className="text-right">
                    <span className="sr-only">操作</span>
                  </TH>
                ) : null}
              </tr>
            </THead>
            <TBody>
              {profiles.map((profile) => (
                <TR key={profile.id}>
                  <TD className="max-w-[14rem]">
                    <span className="block truncate font-medium text-gray-900">{profile.name}</span>
                    <code className="block truncate font-mono text-xs text-gray-500">{profile.key}</code>
                  </TD>
                  <TD className="min-w-[12rem]">
                    <ProfileLocation profile={profile} runtimes={runtimes} />
                  </TD>
                  <TD className="hidden text-gray-500 sm:table-cell">
                    <TimeAgo value={profile.created_at} />
                  </TD>
                  {canManage ? (
                    <TD className="text-right">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setDeleting(profile)}
                        aria-label={`実行環境「${profile.name}」を削除`}
                        title="削除"
                      >
                        <Trash2 className="h-4 w-4 text-gray-500" aria-hidden="true" />
                      </Button>
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </QueryView>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={deleting ? `実行環境「${deleting.name}」を削除しますか？` : "実行環境を削除しますか？"}
        description="削除すると、エージェントの定義（environment.profile）でこのキーを指定していても使えなくなります。この実行環境を使っているデプロイがある場合は削除できません。"
        confirmLabel="削除する"
        onConfirm={async () => {
          if (!deleting) return;
          const id = deleting.id;
          const res = await remove.mutate(id);
          if (!res.ok) return false;
          query.setData((prev) => prev?.filter((p) => p.id !== id));
        }}
      />
    </Card>
  );
}

function ProfileLocation({ profile, runtimes }: { profile: RuntimeProfileDto; runtimes: RuntimeDto[] | undefined }) {
  if (profile.type === "openai_hosted") {
    const network = profile.network;
    const domains = network?.mode === "restricted" ? (network.allowed_domains?.length ?? 0) : null;
    return (
      <span className="block text-sm">
        <span className="block font-medium text-gray-800">{PROFILE_TYPE_LABELS.openai_hosted}</span>
        <span className="block text-xs text-gray-500">
          {profile.template ? OPENAI_TEMPLATE_LABELS[profile.template] : "作業の種類は未設定"}
          {network ? `・${NETWORK_MODE_LABELS[network.mode]}` : null}
          {domains !== null ? `（許可するドメイン ${domains} 件）` : null}
        </span>
      </span>
    );
  }
  if (profile.type === "self_hosted") {
    const summary = profile.runtime;
    const latest = summary ? runtimes?.find((r) => r.id === summary.id) : undefined;
    const status = latest?.status ?? summary?.status;
    return (
      <span className="block text-sm">
        <span className="block font-medium text-gray-800">{PROFILE_TYPE_LABELS.self_hosted}</span>
        {summary ? (
          <span className="mt-1 flex flex-wrap items-center gap-2">
            <Link href={`/runtimes/${summary.id}`} className="text-xs font-medium text-accent-700 hover:underline">
              {summary.name}
            </Link>
            {status ? <RuntimeStatusBadge status={status} /> : null}
            <StageBadge stage={summary.stage} />
          </span>
        ) : (
          <span className="block text-xs text-gray-500">Runtime が見つかりません</span>
        )}
      </span>
    );
  }
  return <span className="text-sm text-gray-600">{PROFILE_TYPE_LABELS.none}</span>;
}
