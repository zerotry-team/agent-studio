"use client";

import { startWorkflowRunSchema, type WorkflowDto, type WorkflowRunDto } from "@agent-studio/contracts";
import { Play, RefreshCw, Workflow } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { listWorkflowRunsAction, startWorkflowRunAction } from "@/actions/workflows";
import { QueryView } from "@/components/common/query-view";
import { WorkflowRunStatusBadge } from "@/components/common/status-badges";
import { TimeAgo } from "@/components/common/time-ago";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import { zodFieldErrors } from "@/lib/utils/zod-ja";

const RUNS_POLL_MS = 5_000;

export function isActiveWorkflowRun(run: Pick<WorkflowRunDto, "status">): boolean {
  return run.status === "running" || run.status === "waiting_approval";
}

function StartWorkflowForm({ workflow }: { workflow: WorkflowDto }) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);
  const mutation = useActionMutation(startWorkflowRunAction, {
    successMessage: "ワークフローを開始しました",
    onSuccess: (run) => router.push(`/workflows/${workflow.id}/runs/${run.id}`),
  });

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const parsed = startWorkflowRunSchema.safeParse({ input });
    if (!parsed.success) {
      setClientError(zodFieldErrors(parsed.error).input ?? "入力内容を確認してください");
      return;
    }
    setClientError(null);
    await mutation.mutate(workflow.id, parsed.data);
  };

  return (
    <Card>
      <CardHeader
        title="ワークフローを実行する"
        description={`現在の定義（バージョン ${workflow.version}）で実行します。入力した内容は、各ステップの {{input}} に入ります。`}
      />
      <CardBody>
        <form onSubmit={onSubmit} noValidate className="space-y-3">
          <Field label="ワークフローへの入力" required error={clientError ?? mutation.fieldErrors.input}>
            <Textarea
              rows={4}
              value={input}
              maxLength={20000}
              onChange={(e) => {
                setInput(e.target.value);
                if (clientError) setClientError(null);
              }}
              placeholder="例: 来月のセール対象商品の価格を見直してください"
            />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={mutation.pending} disabled={!input.trim()} icon={<Play className="h-4 w-4" aria-hidden="true" />}>
              実行する
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

/** ワークフローの「実行」タブ（実行フォームと実行履歴） */
export function WorkflowRunsPanel({ workflow }: { workflow: WorkflowDto }) {
  const { can, organization } = useSession();
  const canRun = can("workflow.run");
  const runs = useActionQuery(() => listWorkflowRunsAction({ workflow_id: workflow.id }), [organization?.id, workflow.id], {
    refetchInterval: (data) => (data?.some(isActiveWorkflowRun) ? RUNS_POLL_MS : false),
  });

  const stepName = (key: string | null): string => {
    if (!key) return "—";
    return workflow.definition.steps.find((s) => s.key === key)?.name ?? key;
  };

  return (
    <div className="space-y-6">
      {canRun ? <StartWorkflowForm workflow={workflow} /> : null}

      <Card>
        <CardHeader
          title="実行履歴"
          description={runs.data?.some(isActiveWorkflowRun) ? "進行中の実行があるため、自動で更新しています。" : undefined}
          actions={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void runs.reload()}
              loading={runs.refreshing}
              icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}
            >
              更新
            </Button>
          }
        />
        <QueryView
          query={runs}
          loading={<TableSkeleton rows={4} columns={4} />}
          compactError
          isEmpty={(items) => items.length === 0}
          empty={
            <EmptyState
              icon={Workflow}
              title="まだ実行されていません"
              description={canRun ? "上のフォームから入力を送ると、ワークフローが始まります。" : "ワークフローが実行されると、ここに表示されます。"}
            />
          }
        >
          {(items) => (
            <Table>
              <THead>
                <tr>
                  <TH>状態</TH>
                  <TH>入力</TH>
                  <TH className="hidden sm:table-cell">現在のステップ</TH>
                  <TH>開始</TH>
                </tr>
              </THead>
              <TBody>
                {items.map((run) => (
                  <TR key={run.id}>
                    <TD>
                      <WorkflowRunStatusBadge status={run.status} />
                    </TD>
                    <TD className="min-w-[10rem] max-w-[20rem]">
                      <Link
                        href={`/workflows/${workflow.id}/runs/${run.id}`}
                        className="block truncate rounded font-medium text-gray-900 hover:text-accent-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                        title={run.input}
                      >
                        {run.input || "（入力なし）"}
                      </Link>
                      {run.workflow.version !== workflow.version ? (
                        <span className="block text-xs text-gray-500">バージョン {run.workflow.version} で実行</span>
                      ) : null}
                    </TD>
                    <TD className="hidden max-w-[12rem] truncate text-gray-600 sm:table-cell">
                      {stepName(run.current_step)}
                    </TD>
                    <TD className="whitespace-nowrap text-gray-500">
                      <TimeAgo value={run.created_at} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </QueryView>
      </Card>
    </div>
  );
}
