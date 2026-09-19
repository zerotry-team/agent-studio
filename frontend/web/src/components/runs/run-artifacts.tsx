"use client";

import { Download, FileText } from "lucide-react";
import { listRunArtifactsAction } from "@/actions/runs";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useActionQuery } from "@/hooks/use-action-query";
import { formatNumber } from "@/lib/utils/format";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${formatNumber(bytes)} B`;
  if (bytes < 1024 * 1024) return `${formatNumber(Math.round(bytes / 102.4) / 10)} KB`;
  return `${formatNumber(Math.round(bytes / (1024 * 102.4)) / 10)} MB`;
}

/** エージェントが作ったファイル（実行が終わってから表示する） */
export function RunArtifacts({ runId, finished }: { runId: string; finished: boolean }) {
  const query = useActionQuery(() => listRunArtifactsAction(runId), [runId, finished], { enabled: finished });
  if (!finished) return null;
  if (query.loading) {
    return (
      <Card>
        <CardHeader title="作成されたファイル" />
        <CardBody>
          <Skeleton className="h-5 w-48" />
        </CardBody>
      </Card>
    );
  }
  if (query.error || !query.data || query.data.length === 0) return null;

  return (
    <Card>
      <CardHeader title="作成されたファイル" description="ダウンロードのリンクは5分間有効です。期限が切れたらページを開き直してください。" />
      <CardBody className="p-0">
        <ul className="divide-y divide-gray-100">
          {query.data.map((a) => (
            <li key={a.path} className="flex items-center justify-between gap-3 px-5 py-3">
              <span className="flex min-w-0 items-center gap-2 text-sm text-gray-800">
                <FileText className="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
                <span className="truncate font-mono text-[13px]">{a.path}</span>
                <span className="shrink-0 text-xs text-gray-500">{formatSize(a.size_bytes)}</span>
              </span>
              <a
                href={a.download_url}
                className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-accent-700 hover:bg-accent-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                rel="noopener noreferrer"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                ダウンロード
              </a>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
