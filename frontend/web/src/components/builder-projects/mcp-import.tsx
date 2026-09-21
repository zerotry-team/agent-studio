"use client";

import type { BuilderMcpInput, BuilderMcpProposalDto, BuilderProjectDto } from "@agent-studio/contracts";
import { PlugZap, RadioTower } from "lucide-react";
import { useState } from "react";
import { applyBuilderMcpAction, inspectBuilderMcpAction } from "@/actions/builder-projects";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { useActionMutation } from "@/hooks/use-action-mutation";

const riskTone = (risk: string) => risk === "read" ? "success" : risk === "write" ? "warning" : "danger";

export function McpImport({ project, onUpdate }: { project: BuilderProjectDto; onUpdate: (project: BuilderProjectDto) => void }) {
  const [serverUrl, setServerUrl] = useState("");
  const [connectorKey, setConnectorKey] = useState("");
  const [connectorName, setConnectorName] = useState("");
  const [authType, setAuthType] = useState<"none" | "static_bearer">("none");
  const [proposal, setProposal] = useState<BuilderMcpProposalDto | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  const inspect = useActionMutation(inspectBuilderMcpAction, {
    onSuccess: (next) => {
      setProposal(next);
      setConnectorKey(next.connector.key);
      setConnectorName(next.connector.name);
      setSelected(next.operations.filter((operation) => operation.selected).map((operation) => operation.remote_name));
    },
  });
  const apply = useActionMutation(applyBuilderMcpAction, {
    successMessage: "MCP連携と操作を生成しました",
    onSuccess: (result) => onUpdate(result.project),
  });

  const value = (withSelection = false): BuilderMcpInput => ({
    server_url: serverUrl,
    ...(connectorKey ? { connector_key: connectorKey } : {}),
    ...(connectorName ? { connector_name: connectorName } : {}),
    auth_type: authType,
    ...(withSelection ? { selected_tool_names: selected, expected_content_hash: proposal?.source.content_hash } : {}),
  });

  return <div className="space-y-5">
    <Card>
      <CardHeader title="MCP Discoveryから連携サービスを生成" description="公開HTTPSサーバーへ接続し、tools/listの入力Schema・注釈・操作名を検査します。Secretはこの画面では受け取りません。" />
      <CardBody className="space-y-4">
        <Field label="MCP Server URL" required hint="Streamable HTTP対応の公開HTTPS URL。内部ネットワークはSelf-hosted Runtimeで扱います。">
          <Input type="url" value={serverUrl} onChange={(event) => { setServerUrl(event.target.value); setProposal(null); }} placeholder="https://mcp.example.com/mcp" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="連携サービスキー" hint="未入力ならホスト名から生成"><Input value={connectorKey} onChange={(event) => setConnectorKey(event.target.value)} placeholder="example-mcp" /></Field>
          <Field label="表示名" hint="未入力ならホスト名を使用"><Input value={connectorName} onChange={(event) => setConnectorName(event.target.value)} placeholder="Example MCP" /></Field>
          <Field label="実行時認証" hint="TokenはConnection作成時だけ入力">
            <Select value={authType} onChange={(event) => { setAuthType(event.target.value as typeof authType); setProposal(null); }}>
              <option value="none">認証なし</option>
              <option value="static_bearer">Bearer Token</option>
            </Select>
          </Field>
        </div>
        <div className="flex justify-end">
          <Button variant="secondary" disabled={!serverUrl} loading={inspect.pending} icon={<RadioTower className="h-4 w-4" />} onClick={() => inspect.mutate({ projectId: project.id, value: value() })}>MCPを検査</Button>
        </div>
      </CardBody>
    </Card>

    {proposal ? <Card>
      <CardHeader
        title={`${proposal.connector.name} の生成候補`}
        description={`${proposal.connector.base_url} · tools/list ${proposal.operations.length}件`}
        actions={<Badge tone={proposal.authentication.requires_human_action ? "warning" : "success"}>{proposal.authentication.requires_human_action ? "接続準備が必要" : "認証不要"}</Badge>}
      />
      <CardBody className="space-y-4">
        {proposal.warnings.length ? <Alert tone="warning" title="安全側の変換・判定があります">{proposal.warnings.join("\n")}</Alert> : null}
        <div className="space-y-3">
          {proposal.operations.map((operation) => {
            const properties = operation.input_schema.properties ? Object.keys(operation.input_schema.properties) : [];
            return <div key={operation.remote_name} className="rounded-lg border border-gray-200 p-4">
              <Checkbox
                checked={selected.includes(operation.remote_name)}
                onChange={(event) => setSelected((current) => event.target.checked ? [...current, operation.remote_name] : current.filter((name) => name !== operation.remote_name))}
                label={<span className="flex flex-wrap items-center gap-2">{operation.display_name}<Badge tone={riskTone(operation.risk)}>{operation.risk}</Badge>{operation.read_only === null ? <Badge tone="warning">readOnly未申告</Badge> : null}</span>}
                description={`${operation.name} · 入力 ${properties.length ? properties.join(", ") : "なし"}`}
              />
              <p className="mt-2 pl-7 text-xs leading-5 text-gray-500">{operation.description}</p>
            </div>;
          })}
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-gray-100 pt-4">
          <p className="text-xs text-gray-500">反映時に再Discoveryし、検査時のハッシュと一致する場合だけTool Versionを固定します。</p>
          <Button disabled={selected.length === 0} loading={apply.pending} icon={<PlugZap className="h-4 w-4" />} onClick={() => apply.mutate({ projectId: project.id, value: value(true) })}>選択した{selected.length}操作を生成</Button>
        </div>
      </CardBody>
    </Card> : null}
  </div>;
}
