"use client";

import type { AuditLogDto } from "@agent-studio/contracts";
import { ArrowDown, RefreshCw, ScrollText, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { listAuditLogsAction } from "@/actions/audit-logs";
import {
  EMPTY_AUDIT_LOG_FILTERS,
  filterAuditLogs,
  hasActiveFilters,
  type AuditLogFilters,
} from "@/components/audit-logs/audit-log-filter";
import { AuditLogFiltersForm } from "@/components/audit-logs/audit-log-filters";
import { AuditLogTable } from "@/components/audit-logs/audit-log-table";
import { Forbidden } from "@/components/common/forbidden";
import { PageHeader } from "@/components/common/page-header";
import { QueryView } from "@/components/common/query-view";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/skeleton";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import type { ActionResult } from "@/lib/utils/action-result";
import { formatNumber } from "@/lib/utils/format";

const PAGE_SIZE = 50;

interface AuditLogPage {
  items: AuditLogDto[];
  /** さらに古い記録があるかもしれない */
  hasMore: boolean;
}

async function fetchFirstPage(): Promise<ActionResult<AuditLogPage>> {
  const res = await listAuditLogsAction({ limit: PAGE_SIZE });
  return res.ok ? { ok: true, data: { items: res.data, hasMore: res.data.length >= PAGE_SIZE } } : res;
}

const DESCRIPTION =
  "組織の中で行われた操作の記録です。誰が・いつ・何をして、結果がどうだったかを確認できます。記録はあとから変更・削除できません。";

function AuditLogsView() {
  const { organization } = useSession();
  const query = useActionQuery(fetchFirstPage, [organization?.id]);
  const [filters, setFilters] = useState<AuditLogFilters>(EMPTY_AUDIT_LOG_FILTERS);
  const more = useActionMutation(listAuditLogsAction);

  const items = query.data?.items;
  const filtered = useMemo(() => (items ? filterAuditLogs(items, filters) : []), [items, filters]);
  const filtering = hasActiveFilters(filters);

  const loadMore = async () => {
    const last = items?.[items.length - 1];
    if (!last) return;
    const res = await more.mutate({ limit: PAGE_SIZE, before: last.created_at });
    if (!res.ok) return;
    query.setData((prev) => {
      if (!prev) return prev;
      const seen = new Set(prev.items.map((i) => i.id));
      return {
        items: [...prev.items, ...res.data.filter((i) => !seen.has(i.id))],
        hasMore: res.data.length >= PAGE_SIZE,
      };
    });
  };

  return (
    <>
      <PageHeader
        title="監査ログ"
        description={DESCRIPTION}
        actions={
          <Button
            variant="secondary"
            onClick={() => void query.reload()}
            loading={query.refreshing}
            disabled={query.loading}
            icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}
          >
            最新の記録を読み込む
          </Button>
        }
      />

      <Card className="mb-4">
        <CardBody>
          <AuditLogFiltersForm value={filters} onChange={setFilters} />
        </CardBody>
      </Card>

      <Card>
        <QueryView
          query={query}
          compactError
          loading={<TableSkeleton rows={8} columns={5} />}
          isEmpty={(page) => page.items.length === 0}
          empty={<EmptyState icon={ScrollText} title="まだ記録はありません" description="組織の中で操作が行われると、ここに記録されます。" />}
        >
          {(page) => (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-5 py-3 text-xs text-gray-500">
                <p aria-live="polite">
                  {filtering
                    ? `${formatNumber(filtered.length)} 件が当てはまります（読み込み済み ${formatNumber(page.items.length)} 件）`
                    : `${formatNumber(page.items.length)} 件を表示しています`}
                </p>
                <p>新しい順</p>
              </div>
              {filtered.length === 0 ? (
                <EmptyState
                  icon={Search}
                  title="条件に当てはまる記録はありません"
                  description={
                    page.hasMore
                      ? "さらに古い記録を読み込むと、見つかる場合があります。"
                      : "検索する言葉や、実行者の種類・結果を変えてお試しください。"
                  }
                  action={
                    <Button variant="secondary" size="sm" onClick={() => setFilters(EMPTY_AUDIT_LOG_FILTERS)}>
                      絞り込みを解除
                    </Button>
                  }
                />
              ) : (
                <AuditLogTable items={filtered} />
              )}
              {page.hasMore ? (
                <div className="flex justify-center border-t border-gray-100 px-5 py-4">
                  <Button
                    variant="secondary"
                    onClick={() => void loadMore()}
                    loading={more.pending}
                    icon={<ArrowDown className="h-4 w-4" aria-hidden="true" />}
                  >
                    さらに読み込む
                  </Button>
                </div>
              ) : page.items.length > PAGE_SIZE ? (
                <p className="border-t border-gray-100 px-5 py-4 text-center text-xs text-gray-500">すべての記録を読み込みました。</p>
              ) : null}
            </>
          )}
        </QueryView>
      </Card>
    </>
  );
}

export default function AuditLogsPage() {
  const { can } = useSession();
  if (!can("audit.view")) {
    return (
      <>
        <PageHeader title="監査ログ" description={DESCRIPTION} />
        <Forbidden description="監査ログは、組織の管理者とオーナーだけが見られます。" />
      </>
    );
  }
  return <AuditLogsView />;
}
