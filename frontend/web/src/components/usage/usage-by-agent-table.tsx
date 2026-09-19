import type { UsageDto } from "@agent-studio/contracts";
import Link from "next/link";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { formatNumber } from "@/lib/utils/format";
import { tokenShare } from "./month";

type AgentUsage = UsageDto["by_agent"][number];

/** エージェントごとの利用量（実行回数の多い順）。割合は入力と出力を合わせたトークン数で計算する */
export function UsageByAgentTable({ rows }: { rows: readonly AgentUsage[] }) {
  const sorted = [...rows].sort(
    (a, b) => b.runs - a.runs || b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens),
  );
  const totalTokens = rows.reduce((sum, r) => sum + r.input_tokens + r.output_tokens, 0);

  return (
    <Table>
      <THead>
        <tr>
          <TH>エージェント</TH>
          <TH className="text-right">実行回数</TH>
          <TH className="hidden text-right sm:table-cell">入力トークン</TH>
          <TH className="hidden text-right sm:table-cell">出力トークン</TH>
          <TH className="w-40 sm:w-56">トークンの割合</TH>
        </tr>
      </THead>
      <TBody>
        {sorted.map((row) => {
          const share = tokenShare(row.input_tokens + row.output_tokens, totalTokens);
          return (
            <TR key={row.agent_id}>
              <TD className="max-w-[16rem]">
                <Link
                  href={`/agents/${row.agent_id}`}
                  className="block truncate font-medium text-gray-900 hover:text-accent-700 hover:underline"
                >
                  {row.agent_name}
                </Link>
                <span className="block text-xs text-gray-500 sm:hidden">
                  入力 {formatNumber(row.input_tokens)}・出力 {formatNumber(row.output_tokens)}
                </span>
              </TD>
              <TD className="whitespace-nowrap text-right tabular-nums text-gray-900">{formatNumber(row.runs)}</TD>
              <TD className="hidden whitespace-nowrap text-right tabular-nums sm:table-cell">{formatNumber(row.input_tokens)}</TD>
              <TD className="hidden whitespace-nowrap text-right tabular-nums sm:table-cell">{formatNumber(row.output_tokens)}</TD>
              <TD>
                <div className="flex items-center gap-3">
                  <div className="h-2 min-w-[4rem] flex-1 overflow-hidden rounded-full bg-gray-100" aria-hidden="true">
                    <div className="h-full rounded-full bg-accent-500" style={{ width: `${share}%` }} />
                  </div>
                  <span className="w-12 shrink-0 text-right text-xs tabular-nums text-gray-600">{share.toFixed(1)}%</span>
                </div>
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}
