"use client";

import type { ConnectionDto, ConnectionScope, ToolExecutionLocation, ToolRisk } from "@agent-studio/contracts";
import { Building2, Globe, Webhook, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { listConnectionsAction } from "@/actions/connections";
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { RadioCards, type RadioCardOption } from "@/components/ui/radio-cards";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import { EXECUTION_LOCATION_LABELS, TOOL_RISK } from "@/lib/utils/labels";
import { InputSchemaField } from "./input-schema-field";
import { errorAt, type ToolSpecDraft } from "./tool-spec";

export const TOOL_RISK_ORDER: readonly ToolRisk[] = ["read", "write", "external_send", "financial", "destructive"];

export const TOOL_RISK_HINTS: Record<ToolRisk, string> = {
  read: "情報を見るだけで、何も変更しません",
  write: "社内システムなどのデータを追加・変更します",
  external_send: "メールや通知など、社外に情報を送ります",
  financial: "価格や支払いなど、金額にかかわる変更をします",
  destructive: "削除など、元に戻せない操作をします",
};

export const EXECUTION_LOCATION_DESCRIPTIONS: Record<ToolExecutionLocation, string> = {
  studio_function: "Agent Studio が指定の URL に送信します（通知や Webhook など）",
  openai_service_mcp: "インターネットに公開された MCP サーバーに OpenAI から接続します",
  runtime_mcp: "社内システムなどを、自社の実行環境（Runtime）の中から安全に呼び出します",
};

export const EXECUTION_LOCATION_ICONS: Record<ToolExecutionLocation, LucideIcon> = {
  studio_function: Webhook,
  openai_service_mcp: Globe,
  runtime_mcp: Building2,
};

const LOCATION_OPTIONS: RadioCardOption<ToolExecutionLocation>[] = (
  ["studio_function", "openai_service_mcp", "runtime_mcp"] as const
).map((value) => ({
  value,
  label: EXECUTION_LOCATION_LABELS[value],
  description: EXECUTION_LOCATION_DESCRIPTIONS[value],
  icon: EXECUTION_LOCATION_ICONS[value],
}));

export interface ToolSpecFormProps {
  value: ToolSpecDraft;
  onChange: (next: ToolSpecDraft) => void;
  /** spec からのパスで表したエラー（例: "description"、"studio_function.url"） */
  errors?: Record<string, string>;
  /** 新しいバージョンを追加するとき: 動く場所を固定する（変更できない） */
  fixedLocation?: ToolExecutionLocation;
  disabled?: boolean;
  /** ダイアログの中で使うとき: 開いたときに説明の入力欄へフォーカスする */
  autoFocusDescription?: boolean;
}

/**
 * ツールのバージョンの設定（説明・リスク・動く場所と、場所ごとの項目）を編集するフォームの部品。
 * ツールの登録と、新しいバージョンの追加の両方で使う。送信ボタンは呼び出し側に置く。
 */
export function ToolSpecForm({
  value,
  onChange,
  errors = {},
  fixedLocation,
  disabled = false,
  autoFocusDescription = false,
}: ToolSpecFormProps) {
  const { organization } = useSession();
  const connections = useActionQuery(() => listConnectionsAction(), [organization?.id]);
  const location = fixedLocation ?? value.execution_location;
  const update = (patch: Partial<ToolSpecDraft>) => onChange({ ...value, ...patch });

  return (
    <div className="space-y-6">
      {errors[""] ? <Alert tone="danger">{errors[""]}</Alert> : null}

      <Field
        label="説明"
        required
        error={errorAt(errors, "description")}
        hint="エージェントがこのツールを使うかどうか判断するための説明です。何ができるか、どんなときに使うかを具体的に書いてください。"
      >
        <Textarea
          rows={3}
          maxLength={1000}
          value={value.description}
          onChange={(e) => update({ description: e.target.value })}
          disabled={disabled}
          placeholder="例: 商品の価格を変更します。変更前に必ず現在の価格を確認してから使ってください。"
          data-autofocus={autoFocusDescription || undefined}
        />
      </Field>

      <Field
        label="リスク"
        required
        error={errorAt(errors, "risk")}
        hint={
          <>
            {TOOL_RISK_HINTS[value.risk]}。リスクに応じて、実行前に承認が必要かどうかの初期値が決まります。
          </>
        }
      >
        <Select value={value.risk} onChange={(e) => update({ risk: e.target.value as ToolRisk })} disabled={disabled}>
          {TOOL_RISK_ORDER.map((risk) => (
            <option key={risk} value={risk}>
              {TOOL_RISK[risk].label}
            </option>
          ))}
        </Select>
      </Field>

      {fixedLocation ? (
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
          <p className="text-xs font-medium text-gray-500">このツールが動く場所</p>
          <p className="mt-1 text-sm font-medium text-gray-900">{EXECUTION_LOCATION_LABELS[fixedLocation]}</p>
          <p className="mt-0.5 text-xs text-gray-500">動く場所は、新しいバージョンでも変えられません。</p>
        </div>
      ) : (
        <RadioCards
          legend="このツールはどこで動きますか？"
          options={LOCATION_OPTIONS.map((o) => ({ ...o, disabled }))}
          value={value.execution_location}
          onChange={(next) => update({ execution_location: next })}
          columns={3}
          error={errorAt(errors, "execution_location")}
        />
      )}

      {location === "studio_function" ? (
        <LocationSection title="送信先の設定">
          <Field
            label="送信先 URL"
            required
            error={errorAt(errors, "studio_function.url")}
            hint="https で始まる URL だけ使えます。エージェントが渡した値を JSON にして POST で送信します。"
          >
            <Input
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://example.com/webhook"
              value={value.webhookUrl}
              onChange={(e) => update({ webhookUrl: e.target.value })}
              disabled={disabled}
            />
          </Field>
          <ConnectionField
            scope="studio"
            value={value.webhookConnectionId}
            onChange={(id) => update({ webhookConnectionId: id })}
            connections={connections.data}
            loading={connections.loading}
            failed={!!connections.error && !connections.data}
            error={errorAt(errors, "studio_function.connection_id") ?? errorAt(errors, "studio_function")}
            disabled={disabled}
            hint="送信するときに、接続先に保管した認証情報をヘッダとして付けます。"
          />
          <InputSchemaField
            value={value.inputSchema}
            onChange={(text) => update({ inputSchema: text })}
            error={errorAt(errors, "input_schema")}
            disabled={disabled}
          />
        </LocationSection>
      ) : null}

      {location === "openai_service_mcp" ? (
        <LocationSection title="MCP サーバーの設定">
          <Field
            label="サーバーの URL"
            required
            error={errorAt(errors, "service_mcp.server_url")}
            hint="https で始まる、インターネットに公開された MCP サーバーの URL です。"
          >
            <Input
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://mcp.example.com/mcp"
              value={value.serverUrl}
              onChange={(e) => update({ serverUrl: e.target.value })}
              disabled={disabled}
            />
          </Field>
          <Field
            label="使ってよいツール"
            optional
            error={errorAt(errors, "service_mcp.allowed_tools")}
            hint="サーバーにあるツールのうち、使ってよいものの名前を 1 行に 1 つずつ書きます。空欄の場合は、すべてのツールを使えます。"
          >
            <Textarea
              mono
              rows={4}
              value={value.allowedTools}
              onChange={(e) => update({ allowedTools: e.target.value })}
              disabled={disabled}
              placeholder={"search_documents\nget_document"}
              autoComplete="off"
              autoCapitalize="off"
            />
          </Field>
          <ConnectionField
            scope="openai_vault"
            value={value.serviceConnectionId}
            onChange={(id) => update({ serviceConnectionId: id })}
            connections={connections.data}
            loading={connections.loading}
            failed={!!connections.error && !connections.data}
            error={errorAt(errors, "service_mcp.connection_id") ?? errorAt(errors, "service_mcp")}
            disabled={disabled}
            hint="OpenAI の保管庫（vault）に保管した認証情報を使って、サーバーに接続します。"
          />
        </LocationSection>
      ) : null}

      {location === "runtime_mcp" ? (
        <LocationSection title="実行環境（Runtime）で動かすための設定">
          <Alert tone="info" title="Runtime 側にも登録が必要です">
            このツールを使うには、自社の実行環境（Runtime）の Tool Gateway にも、同じ名前のツールを登録してください。Agent Studio と
            Runtime の両方で許可されたツールだけが使えます。
          </Alert>
          <InputSchemaField
            value={value.inputSchema}
            onChange={(text) => update({ inputSchema: text })}
            error={errorAt(errors, "input_schema")}
            disabled={disabled}
          />
          <Checkbox
            label="ブラウザや外部の文章など、信頼できない内容を読み込むツールですか？"
            description="はいの場合、書き込み系のツールには承認が必要になります。"
            checked={value.readsUntrustedContent}
            onChange={(e) => update({ readsUntrustedContent: e.target.checked })}
            disabled={disabled}
          />
        </LocationSection>
      ) : null}
    </div>
  );
}

function LocationSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-5 rounded-xl border border-gray-200 bg-gray-50/40 p-4 sm:p-5" aria-label={title}>
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      {children}
    </section>
  );
}

function ConnectionField({
  scope,
  value,
  onChange,
  connections,
  loading,
  failed,
  error,
  disabled,
  hint,
}: {
  scope: Extract<ConnectionScope, "studio" | "openai_vault">;
  value: string;
  onChange: (id: string) => void;
  connections: ConnectionDto[] | undefined;
  loading: boolean;
  failed: boolean;
  error?: string;
  disabled: boolean;
  hint: string;
}) {
  const options = (connections ?? []).filter((c) => c.scope === scope);
  const selected = options.find((c) => c.id === value);
  const unknownSelected = !!value && !!connections && !selected;

  return (
    <Field
      label="認証に使う接続先"
      optional
      error={error}
      hint={
        <>
          {hint}
          {failed ? " 接続先の一覧を読み込めませんでした。" : null}
          {!loading && !failed && options.length === 0 ? (
            <>
              {" "}
              使える接続先がまだありません。
              <Link href="/connections" className="font-medium text-accent-700 hover:underline">
                接続先の画面
              </Link>
              で登録できます。
            </>
          ) : null}
          {selected && !selected.has_secret ? (
            <span className="mt-1 block font-medium text-amber-700">
              この接続先には、まだ認証情報が設定されていません。接続先の画面で設定してください。
            </span>
          ) : null}
        </>
      }
    >
      <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled || loading}>
        <option value="">{loading ? "読み込み中…" : "使わない"}</option>
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.has_secret ? c.name : `${c.name}（認証情報が未設定）`}
          </option>
        ))}
        {unknownSelected ? <option value={value}>見つからない接続先（削除された可能性があります）</option> : null}
      </Select>
    </Field>
  );
}
