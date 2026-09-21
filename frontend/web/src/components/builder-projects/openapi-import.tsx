"use client";

import type { BuilderOpenApiProposalDto, BuilderProjectDto } from "@agent-studio/contracts";
import { FileCheck2, PlugZap } from "lucide-react";
import { useState } from "react";
import { parse } from "yaml";
import { applyBuilderOpenApiAction, inspectBuilderOpenApiAction } from "@/actions/builder-projects";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Checkbox, Input, Textarea } from "@/components/ui/input";
import { useActionMutation } from "@/hooks/use-action-mutation";

const riskTone = (risk: string) => risk === "read" ? "success" : risk === "write" ? "warning" : "danger";

export function OpenApiImport({ project, onUpdate }: { project: BuilderProjectDto; onUpdate: (project: BuilderProjectDto) => void }) {
  const [documentText, setDocumentText] = useState("");
  const [connectorKey, setConnectorKey] = useState("");
  const [connectorName, setConnectorName] = useState("");
  const [proposal, setProposal] = useState<BuilderOpenApiProposalDto | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);

  const parseDocument = () => {
    try {
      const value: unknown = parse(documentText, { maxAliasCount: 20 });
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OpenAPI objectではありません");
      setParseError(null);
      return value as Record<string, unknown>;
    } catch (error) {
      setParseError(`OpenAPIを読み取れません: ${(error as Error).message}`);
      return null;
    }
  };

  const inspect = useActionMutation(inspectBuilderOpenApiAction, {
    onSuccess: (next) => {
      setProposal(next);
      setConnectorKey(next.connector.key);
      setConnectorName(next.connector.name);
      setSelected(next.operations.filter((operation) => operation.selected).map((operation) => operation.operation_id));
    },
  });
  const apply = useActionMutation(applyBuilderOpenApiAction, {
    successMessage: "連携サービスと操作を生成しました",
    onSuccess: (result) => onUpdate(result.project),
  });

  const inspectDocument = async () => {
    const document = parseDocument();
    if (!document) return;
    await inspect.mutate({
      projectId: project.id,
      value: { document, ...(connectorKey ? { connector_key: connectorKey } : {}), ...(connectorName ? { connector_name: connectorName } : {}) },
    });
  };
  const applyDocument = async () => {
    const document = parseDocument();
    if (!document || !proposal || selected.length === 0) return;
    await apply.mutate({
      projectId: project.id,
      value: { document, connector_key: connectorKey, connector_name: connectorName, selected_operation_ids: selected },
    });
  };

  return <div className="space-y-5">
    <Card>
      <CardHeader title="OpenAPIから連携サービスを生成" description="仕様を先に検査し、実行可能な操作・入力・危険度・認証準備を確定します。仕様本文やSecretは保存しません。" />
      <CardBody className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="連携サービスキー" hint="未入力ならAPI名から生成"><Input value={connectorKey} onChange={(event) => setConnectorKey(event.target.value)} placeholder="invoice-cloud" /></Field>
          <Field label="表示名" hint="未入力ならOpenAPIのtitleを使用"><Input value={connectorName} onChange={(event) => setConnectorName(event.target.value)} placeholder="請求書API" /></Field>
        </div>
        <Field label="OpenAPI JSON / YAML" required hint="OpenAPI 3.0 / 3.1。外部$ref、内部URL、認証情報を含むURLは拒否します。">
          <Textarea mono rows={14} value={documentText} onChange={(event) => { setDocumentText(event.target.value); setProposal(null); }} placeholder={'{"openapi":"3.1.0","info":{"title":"Example API","version":"1.0"},"servers":[{"url":"https://api.example.com"}],"paths":{}}'} />
        </Field>
        {parseError ? <Alert tone="danger" title="仕様を確認してください">{parseError}</Alert> : null}
        <div className="flex justify-end"><Button variant="secondary" loading={inspect.pending} icon={<FileCheck2 className="h-4 w-4" />} onClick={inspectDocument}>仕様を検査</Button></div>
      </CardBody>
    </Card>

    {proposal ? <Card>
      <CardHeader title={`${proposal.connector.name} の生成候補`} description={`${proposal.connector.base_url} · OpenAPI ${proposal.source.spec_version}`} actions={<Badge tone={proposal.authentication.requires_human_action ? "warning" : "success"}>{proposal.authentication.requires_human_action ? "接続準備が必要" : "認証不要"}</Badge>} />
      <CardBody className="space-y-4">
        {proposal.warnings.length ? <Alert tone="warning" title="生成しない操作があります">{proposal.warnings.join("\n")}</Alert> : null}
        <div className="space-y-3">
          {proposal.operations.map((operation) => <div key={operation.operation_id} className="rounded-lg border border-gray-200 p-4">
            <Checkbox
              checked={selected.includes(operation.operation_id)}
              onChange={(event) => setSelected((current) => event.target.checked ? [...current, operation.operation_id] : current.filter((id) => id !== operation.operation_id))}
              label={<span className="flex flex-wrap items-center gap-2">{operation.display_name}<Badge tone="neutral">{operation.method}</Badge><Badge tone={riskTone(operation.risk)}>{operation.risk}</Badge></span>}
              description={`${operation.path} · ${operation.name}`}
            />
          </div>)}
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-gray-100 pt-4">
          <p className="text-xs text-gray-500">生成後はTool Version 1と契約・セキュリティ検証証跡を固定します。</p>
          <Button disabled={selected.length === 0} loading={apply.pending} icon={<PlugZap className="h-4 w-4" />} onClick={applyDocument}>選択した{selected.length}操作を生成</Button>
        </div>
      </CardBody>
    </Card> : null}
  </div>;
}
