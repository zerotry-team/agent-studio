"use client";

import type { ApprovalStatus } from "@agent-studio/contracts";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { listApprovalsAction } from "@/actions/approvals";
import { ApprovalCard } from "@/components/approvals/approval-card";
import { PageHeader } from "@/components/common/page-header";
import { QueryView } from "@/components/common/query-view";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/input";
import { CardSkeleton } from "@/components/ui/skeleton";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import { APPROVAL_STATUS } from "@/lib/utils/labels";

type View = "pending" | "history";
type HistoryFilter = "all" | Exclude<ApprovalStatus, "pending">;

const HISTORY_FILTERS: { value: HistoryFilter; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "approved", label: APPROVAL_STATUS.approved.label },
  { value: "denied", label: APPROVAL_STATUS.denied.label },
  { value: "expired", label: APPROVAL_STATUS.expired.label },
  { value: "consumed", label: APPROVAL_STATUS.consumed.label },
];

function ListSkeleton() {
  return (
    <div className="space-y-4">
      <CardSkeleton />
      <CardSkeleton />
    </div>
  );
}

export default function ApprovalsPage() {
  const { can, organization } = useSession();
  const canDecide = can("approval.decide");
  const [view, setView] = useState<View>("pending");
  const [filter, setFilter] = useState<HistoryFilter>("all");

  const pending = useActionQuery(() => listApprovalsAction({ status: "pending" }), [organization?.id], {
    refetchInterval: 15_000,
  });
  const history = useActionQuery(
    () => listApprovalsAction(filter === "all" ? {} : { status: filter }),
    [organization?.id, filter],
    { enabled: view === "history" },
  );

  return (
    <>
      <PageHeader
        title="承認"
        description={
          canDecide
            ? "エージェントが実行する前に承認が必要な操作です。内容を確認して、承認または却下してください。"
            : "エージェントが実行する前に承認が必要な操作の一覧です。承認・却下は承認者だけが行えます。"
        }
      />

      <Tabs
        label="承認の表示切り替え"
        idPrefix="approvals"
        value={view}
        onChange={setView}
        tabs={[
          { id: "pending", label: "承認待ち", badge: pending.data?.length || undefined },
          { id: "history", label: "履歴" },
        ]}
      />

      <TabPanel id="pending" value={view} idPrefix="approvals">
        <QueryView
          query={pending}
          loading={<ListSkeleton />}
          isEmpty={(items) => items.length === 0}
          empty={
            <Card>
              <EmptyState icon={ShieldCheck} title="承認を待っている操作はありません" description="承認が必要な操作が発生すると、ここに表示されます。" />
            </Card>
          }
        >
          {(items) => (
            <div className="space-y-4">
              {items.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  canDecide={canDecide}
                  onDecided={() => {
                    pending.setData((prev) => prev?.filter((a) => a.id !== approval.id));
                  }}
                />
              ))}
            </div>
          )}
        </QueryView>
      </TabPanel>

      <TabPanel id="history" value={view} idPrefix="approvals">
        <div className="mb-4 max-w-xs">
          <Field label="表示する結果">
            <Select value={filter} onChange={(e) => setFilter(e.target.value as HistoryFilter)}>
              {HISTORY_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <QueryView
          query={history}
          loading={<ListSkeleton />}
          isEmpty={(items) => items.filter((a) => a.status !== "pending").length === 0}
          empty={
            <Card>
              <EmptyState icon={ShieldCheck} title="該当する履歴はありません" />
            </Card>
          }
        >
          {(items) => (
            <div className="space-y-4">
              {items
                .filter((a) => a.status !== "pending")
                .map((approval) => (
                  <ApprovalCard key={approval.id} approval={approval} canDecide={false} />
                ))}
            </div>
          )}
        </QueryView>
      </TabPanel>
    </>
  );
}
