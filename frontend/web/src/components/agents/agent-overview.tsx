"use client";

import type { AgentDto, AgentVersionDto } from "@agent-studio/contracts";
import { Upload } from "lucide-react";
import { useState } from "react";
import { publishAgentVersionAction } from "@/actions/agents";
import { AgentVersionStatusBadge } from "@/components/common/status-badges";
import { TimeAgo } from "@/components/common/time-ago";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useSession } from "@/hooks/use-session";
import { ManifestSummary } from "./manifest-summary";

export interface AgentOverviewProps {
  agent: AgentDto;
  /** 公開したあとにエージェントを読み込み直す */
  onChanged: () => Promise<void>;
  memberName: (userId: string | null) => string | null;
}

export function AgentOverview({ agent, onChanged, memberName }: AgentOverviewProps) {
  const { can } = useSession();
  const canEdit = can("agent.edit");
  const versions = agent.versions ?? [];
  const latest = versions[0];
  const [target, setTarget] = useState<AgentVersionDto | null>(null);
  const publish = useActionMutation(publishAgentVersionAction, {
    successMessage: (v) => `バージョン ${v.version} を公開しました`,
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="定義の要点"
          description={latest ? `最新のバージョン（v${latest.version}）の内容です。` : undefined}
          actions={latest ? <AgentVersionStatusBadge status={latest.status} /> : null}
        />
        <CardBody>
          {latest ? (
            <ManifestSummary manifest={latest.manifest} />
          ) : (
            <p className="text-sm text-gray-500">バージョンがまだありません。</p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="バージョン"
          description="公開したバージョンは変更できず、デプロイに使えるようになります。定義を直すときは、新しいバージョンを作って公開します。"
        />
        {versions.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-gray-500">バージョンがまだありません。</p>
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>バージョン</TH>
                <TH>状態</TH>
                <TH>作成</TH>
                <TH className="hidden sm:table-cell">公開</TH>
                {canEdit ? (
                  <TH>
                    <span className="sr-only">操作</span>
                  </TH>
                ) : null}
              </tr>
            </THead>
            <TBody>
              {versions.map((v) => {
                const author = memberName(v.created_by);
                return (
                  <TR key={v.id}>
                    <TD className="font-medium tabular-nums text-gray-900">
                      v{v.version}
                      {v.version === agent.latest_version ? (
                        <span className="ml-2 text-xs font-normal text-gray-500">最新</span>
                      ) : null}
                    </TD>
                    <TD>
                      <AgentVersionStatusBadge status={v.status} />
                    </TD>
                    <TD className="text-gray-500">
                      <TimeAgo value={v.created_at} />
                      {author ? <span className="block max-w-[12rem] truncate text-xs">{author}</span> : null}
                    </TD>
                    <TD className="hidden text-gray-500 sm:table-cell">
                      <TimeAgo value={v.published_at} fallback="—" />
                    </TD>
                    {canEdit ? (
                      <TD className="text-right">
                        {v.status === "draft" ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            icon={<Upload className="h-4 w-4" aria-hidden="true" />}
                            onClick={() => setTarget(v)}
                            aria-label={`バージョン ${v.version} を公開する`}
                          >
                            公開する
                          </Button>
                        ) : null}
                      </TD>
                    ) : null}
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>

      <ConfirmDialog
        open={target !== null}
        onClose={() => setTarget(null)}
        tone="primary"
        title={target ? `バージョン ${target.version} を公開しますか？` : "バージョンを公開しますか？"}
        description="公開したバージョンは変更できなくなり、デプロイに使えるようになります。"
        confirmLabel="公開する"
        onConfirm={async () => {
          if (!target) return;
          const res = await publish.mutate(agent.id, target.version);
          if (!res.ok) return false;
          await onChanged();
        }}
      >
        <p className="text-sm leading-relaxed text-gray-600">
          公開したあとは「デプロイ」タブから、実行環境にデプロイできます。
        </p>
      </ConfirmDialog>
    </div>
  );
}
