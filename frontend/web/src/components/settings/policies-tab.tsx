"use client";

import type { PolicyDto } from "@agent-studio/contracts";
import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { deletePolicyAction, listPoliciesAction, updatePolicyAction } from "@/actions/policies";
import { QueryView } from "@/components/common/query-view";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import { cn } from "@/lib/utils/cn";
import { formatDateTime } from "@/lib/utils/format";
import { POLICY_TYPE_LABELS, type Tone } from "@/lib/utils/labels";
import { describePolicyRule } from "./policy-describe";
import { CreatePolicyDialog } from "./policy-form-dialog";

const TYPE_TONES: Record<PolicyDto["rule"]["type"], Tone> = {
  approval: "warning",
  deny: "danger",
  rate_limit: "info",
  time_window: "accent",
};

function PolicyItem({
  policy,
  canManage,
  toggling,
  onToggle,
  onDelete,
}: {
  policy: PolicyDto;
  canManage: boolean;
  toggling: boolean;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const { rule } = policy;
  const reason = rule.type === "approval" || rule.type === "deny" ? rule.reason : undefined;
  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className={cn("min-w-0 space-y-1.5", !policy.enabled && "opacity-60")}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="break-words text-sm font-semibold text-gray-900">{policy.name}</h3>
          <Badge tone={TYPE_TONES[rule.type]}>{POLICY_TYPE_LABELS[rule.type]}</Badge>
          {!policy.enabled ? <Badge tone="neutral">無効</Badge> : null}
        </div>
        <p className="text-xs text-gray-500">
          対象:{" "}
          {rule.tool === "*" ? (
            <span className="font-medium text-gray-700">すべてのツール</span>
          ) : (
            <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[12px] text-gray-800">{rule.tool}</code>
          )}
        </p>
        <p className="text-sm leading-relaxed text-gray-800">{describePolicyRule(rule)}</p>
        {reason ? <p className="text-xs leading-relaxed text-gray-500">理由: {reason}</p> : null}
        <p className="text-xs text-gray-400">更新: {formatDateTime(policy.updated_at)}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {canManage ? (
          <>
            <Switch
              label={`${policy.name} を有効にする`}
              checked={policy.enabled}
              disabled={toggling}
              onChange={onToggle}
            >
              {policy.enabled ? "有効" : "無効"}
            </Switch>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-2 text-gray-500 hover:bg-red-50 hover:text-red-700"
              onClick={onDelete}
              aria-label={`${policy.name} を削除`}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          </>
        ) : (
          <Badge tone={policy.enabled ? "success" : "neutral"} dot>
            {policy.enabled ? "有効" : "無効"}
          </Badge>
        )}
      </div>
    </li>
  );
}

export function PoliciesTab() {
  const { organization, can } = useSession();
  const canManage = can("policy.manage");
  const query = useActionQuery(() => listPoliciesAction(), [organization?.id]);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<PolicyDto | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const update = useActionMutation(updatePolicyAction, {
    successMessage: (p) => (p.enabled ? `「${p.name}」を有効にしました` : `「${p.name}」を無効にしました`),
  });
  const remove = useActionMutation(deletePolicyAction, { successMessage: "ポリシーを削除しました" });

  const toggle = async (policy: PolicyDto, enabled: boolean) => {
    setTogglingId(policy.id);
    const res = await update.mutate(policy.id, { enabled });
    setTogglingId(null);
    if (res.ok) query.setData((prev) => prev?.map((p) => (p.id === res.data.id ? res.data : p)));
  };

  const addButton = canManage ? (
    <Button onClick={() => setCreating(true)} icon={<Plus className="h-4 w-4" aria-hidden="true" />}>
      ポリシーを追加
    </Button>
  ) : null;

  return (
    <div className="space-y-4">
      <Alert tone="info" title="組織全体のポリシー">
        組織のすべてのエージェントに適用されます。エージェントごとのポリシーと重なる場合は、より厳しいほうが優先されます。
      </Alert>

      <Card>
        <CardHeader
          title="ポリシー"
          description="ツールの使い方についてのルールです。無効にしたポリシーは適用されません。"
          actions={addButton}
        />
        <QueryView
          query={query}
          compactError
          loading={<TableSkeleton rows={3} columns={3} />}
          isEmpty={(items) => items.length === 0}
          empty={
            <EmptyState
              icon={ShieldCheck}
              title="組織全体のポリシーはまだありません"
              description="ポリシーを追加すると、すべてのエージェントのツールの使い方を制限できます。例: 金額を大きく変えるときは承認を必要にする。"
              action={addButton}
            />
          }
        >
          {(policies) => (
            <ul className="divide-y divide-gray-100">
              {policies.map((policy) => (
                <PolicyItem
                  key={policy.id}
                  policy={policy}
                  canManage={canManage}
                  toggling={togglingId === policy.id}
                  onToggle={(enabled) => void toggle(policy, enabled)}
                  onDelete={() => setDeleting(policy)}
                />
              ))}
            </ul>
          )}
        </QueryView>
      </Card>

      {creating ? (
        <CreatePolicyDialog
          onClose={() => setCreating(false)}
          onCreated={(policy) => query.setData((prev) => [...(prev ?? []), policy])}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="ポリシーを削除しますか？"
        description={
          deleting
            ? `「${deleting.name}」を削除すると、すべてのエージェントにこのルールが適用されなくなります。一時的に止めたいだけなら、削除せずに無効にしてください。`
            : undefined
        }
        confirmLabel="削除する"
        onConfirm={async () => {
          if (!deleting) return;
          const target = deleting;
          const res = await remove.mutate(target.id);
          if (!res.ok) return false;
          query.setData((prev) => prev?.filter((p) => p.id !== target.id));
          return undefined;
        }}
      />
    </div>
  );
}
