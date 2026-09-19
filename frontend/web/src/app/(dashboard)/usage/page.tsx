"use client";

import { ArrowDownToLine, ArrowUpFromLine, ChartColumn, Play } from "lucide-react";
import { useState } from "react";
import { getUsageAction } from "@/actions/usage";
import { Forbidden } from "@/components/common/forbidden";
import { PageHeader } from "@/components/common/page-header";
import { QueryView } from "@/components/common/query-view";
import { StatCard } from "@/components/dashboard/stat-card";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton, SkeletonGroup, TableSkeleton } from "@/components/ui/skeleton";
import { formatMonthLabel } from "@/components/usage/month";
import { MonthPicker } from "@/components/usage/month-picker";
import { UsageByAgentTable } from "@/components/usage/usage-by-agent-table";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import { currentMonth, formatNumber } from "@/lib/utils/format";

const DESCRIPTION = "月ごとの実行回数と、OpenAI で使ったトークン数です。";

function UsageSkeleton() {
  return (
    <SkeletonGroup>
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-3 h-7 w-20" />
          </div>
        ))}
      </div>
      <div className="mt-6 rounded-xl border border-gray-200 bg-white shadow-sm">
        <TableSkeleton rows={4} columns={5} />
      </div>
    </SkeletonGroup>
  );
}

function UsageView() {
  const { organization } = useSession();
  const [thisMonth] = useState(() => currentMonth());
  const [month, setMonth] = useState(thisMonth);
  const query = useActionQuery(() => getUsageAction(month), [organization?.id, month]);

  return (
    <>
      <PageHeader title="利用状況" description={DESCRIPTION} />

      <div className="mb-6">
        <MonthPicker value={month} onChange={setMonth} max={thisMonth} />
      </div>

      <QueryView query={query} loading={<UsageSkeleton />}>
        {(usage) => (
          <div className="space-y-6">
            <h2 className="sr-only">{formatMonthLabel(usage.month)}の利用状況</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label="実行回数" value={formatNumber(usage.runs)} icon={Play} hint={`${formatMonthLabel(usage.month)}の合計`} />
              <StatCard
                label="入力トークン"
                value={formatNumber(usage.input_tokens)}
                icon={ArrowDownToLine}
                hint="エージェントに渡した文章などの量"
              />
              <StatCard
                label="出力トークン"
                value={formatNumber(usage.output_tokens)}
                icon={ArrowUpFromLine}
                hint="エージェントが生成した文章などの量"
              />
            </div>

            <Card>
              <CardHeader
                title="エージェントごとの利用"
                description={`${formatMonthLabel(usage.month)}に実行されたエージェントです（実行回数の多い順）。`}
              />
              {usage.by_agent.length === 0 ? (
                <EmptyState
                  icon={ChartColumn}
                  title="この月の利用はありません"
                  description="エージェントを実行すると、ここに実行回数とトークン数が表示されます。"
                />
              ) : (
                <UsageByAgentTable rows={usage.by_agent} />
              )}
            </Card>

            <p className="text-xs leading-relaxed text-gray-500">
              OpenAI の利用料金は、御社専用の OpenAI の Project ごとに照合されます。料金の詳細は OpenAI のダッシュボードで確認してください。
              ここに表示するトークン数は、Agent Studio が記録した実行の合計です。
            </p>
          </div>
        )}
      </QueryView>
    </>
  );
}

export default function UsagePage() {
  const { can } = useSession();
  if (!can("usage.view")) {
    return (
      <>
        <PageHeader title="利用状況" description={DESCRIPTION} />
        <Forbidden description="利用状況は、組織の管理者とオーナーだけが見られます。" />
      </>
    );
  }
  return <UsageView />;
}
