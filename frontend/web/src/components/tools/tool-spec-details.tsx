"use client";

import type { ConnectionDto, ToolVersionSpec } from "@agent-studio/contracts";
import Link from "next/link";
import type { ReactNode } from "react";
import { ToolRiskBadge } from "@/components/common/status-badges";
import { Badge } from "@/components/ui/badge";
import { JsonView } from "@/components/ui/code-block";
import { DescriptionList, type DescriptionItem } from "@/components/ui/description-list";
import { EXECUTION_LOCATION_LABELS } from "@/lib/utils/labels";

export interface ToolSpecDetailsProps {
  spec: ToolVersionSpec;
  /** 接続先の名前を表示するための一覧（読み込めていない場合は undefined） */
  connections?: ConnectionDto[];
}

function ConnectionName({ id, connections }: { id: string | undefined; connections?: ConnectionDto[] }) {
  if (!id) return <span className="text-gray-500">使わない</span>;
  if (!connections) return <span className="font-mono text-xs text-gray-500">{id}</span>;
  const connection = connections.find((c) => c.id === id);
  if (!connection) return <span className="text-gray-500">見つからない接続先（削除された可能性があります）</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Link href="/connections" className="font-medium text-gray-900 hover:text-accent-700 hover:underline">
        {connection.name}
      </Link>
      {connection.has_secret ? null : <Badge tone="warning">認証情報が未設定</Badge>}
    </span>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="break-all font-mono text-[13px] text-gray-800">{children}</span>;
}

/** ツールのバージョンの設定を、項目ごとに読みやすく表示する */
export function ToolSpecDetails({ spec, connections }: ToolSpecDetailsProps) {
  const items: DescriptionItem[] = [
    { label: "説明", value: <span className="whitespace-pre-wrap">{spec.description}</span>, wide: true },
    { label: "動く場所", value: EXECUTION_LOCATION_LABELS[spec.execution_location] },
    { label: "リスク", value: <ToolRiskBadge risk={spec.risk} /> },
  ];

  switch (spec.execution_location) {
    case "studio_function":
      if (spec.studio_function.handler === "http_api") {
        items.push(
          { label: "API", value: <Mono>{spec.studio_function.method} {spec.studio_function.base_url}{spec.studio_function.path}</Mono>, wide: true },
          { label: "認証", value: "Agent ProjectのConnectionを実行時に使用" },
          { label: "入力の形式（JSON Schema）", value: <JsonView value={spec.input_schema} maxHeight="20rem" />, wide: true },
        );
      } else {
        items.push(
          { label: "送信先 URL", value: <Mono>{spec.studio_function.url}</Mono>, wide: true },
          { label: "認証に使う接続先", value: <ConnectionName id={spec.studio_function.connection_id} connections={connections} /> },
          { label: "入力の形式（JSON Schema）", value: <JsonView value={spec.input_schema} maxHeight="20rem" />, wide: true },
        );
      }
      break;
    case "openai_service_mcp": {
      const allowed = spec.service_mcp.allowed_tools ?? [];
      items.push(
        { label: "サーバーの URL", value: <Mono>{spec.service_mcp.server_url}</Mono>, wide: true },
        { label: "認証に使う接続先", value: <ConnectionName id={spec.service_mcp.connection_id} connections={connections} /> },
        {
          label: "使ってよいツール",
          value:
            allowed.length === 0 ? (
              "すべてのツール"
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {allowed.map((name) => (
                  <li key={name} className="rounded-md bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-800">
                    {name}
                  </li>
                ))}
              </ul>
            ),
          wide: allowed.length > 0,
        },
      );
      break;
    }
    case "runtime_mcp":
      items.push(
        {
          label: "信頼できない内容を読み込むか",
          value: spec.reads_untrusted_content ? (
            <span>
              はい<span className="ml-1 text-xs text-gray-500">（書き込み系のツールには承認が必要になります）</span>
            </span>
          ) : (
            "いいえ"
          ),
        },
        { label: "入力の形式（JSON Schema）", value: <JsonView value={spec.input_schema} maxHeight="20rem" />, wide: true },
      );
      break;
  }

  return <DescriptionList items={items} columns={2} />;
}
