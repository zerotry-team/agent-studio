"use client";

import { TERMINAL_RUN_STATUSES, type DeploymentDto } from "@agent-studio/contracts";
import { ArrowRight, History, Play, Rocket } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { listRunsAction, startRunAction } from "@/actions/runs";
import { QueryView } from "@/components/common/query-view";
import { RunStatusBadge } from "@/components/common/status-badges";
import { TimeAgo } from "@/components/common/time-ago";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { CardSkeleton, TableSkeleton } from "@/components/ui/skeleton";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useActionQuery, type ActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import { cn } from "@/lib/utils/cn";
import { activeDeployments, deploymentLabel, DeploymentSelect, type AgentTab } from "./deployment-select";

const INPUT_MAX = 20000;

export interface AgentRunProps {
  deployments: ActionQuery<DeploymentDto[]>;
  onGoToTab: (tab: AgentTab) => void;
}

export function AgentRun({ deployments, onGoToTab }: AgentRunProps) {
  return (
    <QueryView query={deployments} loading={<CardSkeleton />}>
      {(items) => {
        const active = activeDeployments(items);
        if (active.length === 0) return <NoActiveDeployment onGoToTab={onGoToTab} />;
        return <RunPanel active={active} />;
      }}
    </QueryView>
  );
}

function NoActiveDeployment({ onGoToTab }: { onGoToTab: (tab: AgentTab) => void }) {
  return (
    <Card>
      <EmptyState
        icon={Rocket}
        title="稼働中のデプロイがありません"
        description="エージェントを実行するには、公開したバージョンを実行環境にデプロイしてください。"
        action={
          <Button variant="secondary" size="sm" onClick={() => onGoToTab("deploy")}>
            デプロイの画面へ
          </Button>
        }
      />
    </Card>
  );
}

function RunPanel({ active }: { active: DeploymentDto[] }) {
  const { can } = useSession();
  const canRun = can("run.start");
  const router = useRouter();
  const [deploymentId, setDeploymentId] = useState("");
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);

  const selected = active.find((d) => d.id === deploymentId) ?? active[0];
  const selectedId = selected?.id;

  const [navigating, setNavigating] = useState(false);
  const start = useActionMutation(startRunAction, {
    successMessage: "実行を開始しました",
    onSuccess: (run) => {
      setNavigating(true);
      router.push(`/runs/${run.id}`);
    },
  });
  const busy = start.pending || navigating;

  const runs = useActionQuery(
    () => listRunsAction({ deployment_id: selectedId ?? "", limit: 10 }),
    [selectedId],
    {
      enabled: !!selectedId,
      refetchInterval: (data) => (data?.some((r) => !TERMINAL_RUN_STATUSES.includes(r.status)) ? 5000 : false),
    },
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!selected || busy) return;
    const text = input.trim();
    const error = !text ? "指示を入力してください" : text.length > INPUT_MAX ? `${INPUT_MAX} 文字以内で入力してください` : null;
    setInputError(error);
    if (error) return;
    void start.mutate({ deployment_id: selected.id, input: text });
  };

  if (!selected) return null;
  const length = input.trim().length;

  return (
    <div className="space-y-6">
      <Card>
        <form onSubmit={onSubmit} noValidate>
          <CardHeader
            title="エージェントを実行する"
            description={
              canRun
                ? "指示を入力して実行すると、実行の様子を確認する画面に移ります。"
                : "実行は、実行担当以上の権限を持つメンバーが行えます。ここでは最近の実行を確認できます。"
            }
          />
          <CardBody className="space-y-5">
            <DeploymentSelect
              label="どのデプロイで実行しますか？"
              deployments={active}
              value={selected.id}
              onChange={setDeploymentId}
              disabled={busy}
            />
            {selected.stage === "production" && canRun ? (
              <Alert tone="warning">本番のデプロイで実行します。実際のデータが変更される場合があります。</Alert>
            ) : null}
            {canRun ? (
              <Field
                label="エージェントへの指示"
                required
                error={inputError ?? start.fieldErrors.input}
                hint={
                  <span className={cn("tabular-nums", length > INPUT_MAX && "font-medium text-red-600")}>
                    {length} / {INPUT_MAX} 文字
                  </span>
                }
              >
                <Textarea
                  rows={5}
                  value={input}
                  disabled={busy}
                  onChange={(e) => {
                    setInput(e.target.value);
                    if (inputError) setInputError(null);
                  }}
                  placeholder="例: 商品Xの価格を400円下げてください"
                />
              </Field>
            ) : null}
          </CardBody>
          {canRun ? (
            <CardFooter>
              <Button type="submit" loading={busy} icon={<Play className="h-4 w-4" aria-hidden="true" />}>
                実行する
              </Button>
            </CardFooter>
          ) : null}
        </form>
      </Card>

      <Card>
        <CardHeader
          title="最近の実行"
          description={`「${deploymentLabel(selected)}」での実行です。`}
          actions={
            <Link href="/runs" className="inline-flex items-center gap-1 text-sm font-medium text-accent-700 hover:underline">
              すべての実行履歴
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          }
        />
        <QueryView
          query={runs}
          compactError
          loading={<TableSkeleton rows={3} columns={3} />}
          isEmpty={(items) => items.length === 0}
          empty={<EmptyState icon={History} title="まだ実行されていません" description="このデプロイで実行すると、ここに表示されます。" />}
        >
          {(items) => (
            <ul className="divide-y divide-gray-100">
              {items.map((run) => (
                <li key={run.id}>
                  <Link
                    href={`/runs/${run.id}`}
                    className="flex items-start justify-between gap-3 px-5 py-3 hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-gray-900">{run.input}</span>
                      <span className="mt-0.5 block text-xs text-gray-500">
                        <TimeAgo value={run.created_at} />
                      </span>
                    </span>
                    <RunStatusBadge status={run.status} outcome={run.outcome} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </QueryView>
      </Card>
    </div>
  );
}
