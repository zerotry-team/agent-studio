"use client";

import type { AutoApprovalMode, AutoApprovalPolicyConfig, AutoApprovalPolicyDto } from "@agent-studio/contracts";
import { OctagonX, Save, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import {
  getAutoApprovalPolicyAction,
  setAutoApprovalEmergencyStopAction,
  setAutoApprovalPolicyAction,
} from "@/actions/policies";
import { QueryView } from "@/components/common/query-view";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, FieldSet } from "@/components/ui/field";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { TableSkeleton } from "@/components/ui/skeleton";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function lines(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

function localDateTime(iso: string | null): string {
  if (!iso) return "";
  const value = new Date(iso);
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function Editor({ value, onSaved }: { value: AutoApprovalPolicyDto; onSaved: (value: AutoApprovalPolicyDto) => void }) {
  const { can } = useSession();
  const canManage = can("policy.manage");
  const [config, setConfig] = useState<AutoApprovalPolicyConfig>(value.config);
  const [hosts, setHosts] = useState(value.config.allowed_hosts.join("\n"));
  const [operations, setOperations] = useState(value.config.allowed_operations.join("\n"));
  useEffect(() => {
    setConfig(value.config);
    setHosts(value.config.allowed_hosts.join("\n"));
    setOperations(value.config.allowed_operations.join("\n"));
  }, [value]);
  const save = useActionMutation(setAutoApprovalPolicyAction, { successMessage: "自動承認Policyを保存しました" });
  const stop = useActionMutation(setAutoApprovalEmergencyStopAction, {
    successMessage: (result) => (result.emergency_stopped_at ? "自動承認を緊急停止しました" : "自動承認を再開しました"),
  });

  const toggleMethod = (method: (typeof METHODS)[number], checked: boolean) => {
    setConfig((current) => ({
      ...current,
      allowed_methods: checked ? [...new Set([...current.allowed_methods, method])] : current.allowed_methods.filter((item) => item !== method),
    }));
  };

  return (
    <Card>
      <CardHeader
        title="自動承認"
        description="組織Policyが承認者になります。許可していない接続先・操作・環境は従来どおり人の承認で停止します。"
        actions={value.version > 0 ? <span className="text-xs text-gray-500">Policy v{value.version}</span> : undefined}
      />
      <CardBody className="space-y-5">
        {value.emergency_stopped_at ? (
          <Alert tone="danger" title="自動承認は緊急停止中です">すべての操作を手動承認へ戻しています。</Alert>
        ) : null}
        <Field label="承認モード" required>
          <Select
            value={config.mode}
            disabled={!canManage}
            onChange={(event) => setConfig((current) => ({ ...current, mode: event.target.value as AutoApprovalMode }))}
          >
            <option value="manual">個別承認</option>
            <option value="safe_operations">安全操作を自動承認</option>
            <option value="all_within_policy">すべて自動で進める</option>
          </Select>
        </Field>
        <div className="grid gap-5 lg:grid-cols-2">
          <Field label="許可するAPI host" hint="完全一致のFQDNを1行に1つ。ワイルドカードやIP直指定は使えません。">
            <Textarea value={hosts} rows={4} disabled={!canManage} placeholder="api.company.example" onChange={(event) => setHosts(event.target.value)} mono />
          </Field>
          <Field label="許可する操作" hint="Tool名またはシステム操作を1行に1つ。Production昇格、再試行、Rollbackも完全一致で許可します。">
            <Textarea value={operations} rows={6} disabled={!canManage} placeholder={'lookup_contract\nupdate_contract_status\nproduction_promotion\nbuilder_retry\nproduction_rollback'} onChange={(event) => setOperations(event.target.value)} mono />
          </Field>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <FieldSet legend="環境">
            {(["staging", "production"] as const).map((stage) => (
              <Checkbox
                key={stage}
                label={stage === "staging" ? "Preview" : "Production"}
                disabled={!canManage}
                checked={config.environments.includes(stage)}
                onChange={(event) => setConfig((current) => ({
                  ...current,
                  environments: event.target.checked ? [...new Set([...current.environments, stage])] : current.environments.filter((item) => item !== stage),
                }))}
              />
            ))}
          </FieldSet>
          <FieldSet legend="HTTP method" description="DELETEは拒否リストに固定され、自動承認されません。">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {METHODS.map((method) => (
                <Checkbox
                  key={method}
                  label={method}
                  disabled={!canManage || method === "DELETE"}
                  checked={config.allowed_methods.includes(method)}
                  onChange={(event) => toggleMethod(method, event.target.checked)}
                />
              ))}
            </div>
          </FieldSet>
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="1分あたりの自動承認数">
            <Input type="number" min={1} max={10000} disabled={!canManage} value={config.limits.requests_per_minute} onChange={(event) => setConfig((current) => ({ ...current, limits: { ...current.limits, requests_per_minute: Number(event.target.value) } }))} />
          </Field>
          <Field label="1回の最大レコード数">
            <Input type="number" min={1} max={100000} disabled={!canManage} value={config.limits.max_records_per_call} onChange={(event) => setConfig((current) => ({ ...current, limits: { ...current.limits, max_records_per_call: Number(event.target.value) } }))} />
          </Field>
          <Field label="1日の費用上限（円）" hint="空欄は費用による自動承認制限なし。">
            <Input
              type="number"
              min={1}
              max={100000000}
              disabled={!canManage}
              value={config.limits.daily_cost_jpy ?? ""}
              onChange={(event) => setConfig((current) => ({ ...current, limits: { ...current.limits, daily_cost_jpy: event.target.value ? Number(event.target.value) : null } }))}
            />
          </Field>
          <Field label="自動承認の有効期限" hint="期限切れ後は自動的に手動承認へ戻ります。">
            <Input
              type="datetime-local"
              disabled={!canManage}
              value={localDateTime(config.expires_at)}
              onChange={(event) => setConfig((current) => ({ ...current, expires_at: event.target.value ? new Date(event.target.value).toISOString() : null }))}
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Checkbox label="Production昇格" disabled={!canManage} checked={config.production_promotion} onChange={(event) => setConfig((current) => ({ ...current, production_promotion: event.target.checked }))} />
          <Checkbox label="自動再試行" disabled={!canManage} checked={config.automatic_retry} onChange={(event) => setConfig((current) => ({ ...current, automatic_retry: event.target.checked }))} />
          <Checkbox label="自動Rollback" disabled={!canManage} checked={config.automatic_rollback} onChange={(event) => setConfig((current) => ({ ...current, automatic_rollback: event.target.checked }))} />
        </div>
        <p className="text-xs leading-relaxed text-gray-500">Secret登録、OAuth同意、新しいhost、権限拡大、予算上限変更はこの設定では自動化されません。</p>
      </CardBody>
      {canManage ? (
        <CardFooter className="justify-between sm:justify-between">
          <Button
            variant={value.emergency_stopped_at ? "secondary" : "danger-outline"}
            icon={value.emergency_stopped_at ? <ShieldCheck className="h-4 w-4" /> : <OctagonX className="h-4 w-4" />}
            loading={stop.pending}
            disabled={value.id === null}
            onClick={async () => {
              const result = await stop.mutate({ stopped: !value.emergency_stopped_at });
              if (result.ok) onSaved(result.data);
            }}
          >
            {value.emergency_stopped_at ? "自動承認を再開" : "緊急停止"}
          </Button>
          <Button
            icon={<Save className="h-4 w-4" />}
            loading={save.pending}
            onClick={async () => {
              const result = await save.mutate({ ...config, allowed_hosts: lines(hosts), allowed_operations: lines(operations), denied_methods: ["DELETE"] });
              if (result.ok) onSaved(result.data);
            }}
          >
            保存
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}

export function AutoApprovalCard() {
  const { organization } = useSession();
  const query = useActionQuery(() => getAutoApprovalPolicyAction(), [organization?.id]);
  return (
    <QueryView query={query} compactError loading={<TableSkeleton rows={4} columns={2} />}>
      {(value) => <Editor value={value} onSaved={(next) => query.setData(next)} />}
    </QueryView>
  );
}
