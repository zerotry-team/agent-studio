"use client";

import {
  createConnectorSchema,
  type ConnectorAdapter,
  type ConnectorDto,
  type ConnectorOperationInput,
  type CreateConnectorInput,
} from "@agent-studio/contracts";
import { Download, Globe, Plug, Plus, Trash2 } from "lucide-react";
import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { createConnectorAction, discoverMcpToolsAction, updateConnectorAction } from "@/actions/connectors";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { RadioCards, type RadioCardOption } from "@/components/ui/radio-cards";
import { DEFAULT_INPUT_SCHEMA_TEXT, inputSchemaTextError } from "@/components/tools/tool-spec";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { zodFieldErrors } from "@/lib/utils/zod-ja";

/** この画面から登録できるのは、外部から接続できるサービスだけ。社内システムは Runtime 側で扱う。 */
type Kind = Extract<ConnectorAdapter, "http_openapi" | "mcp">;

const KIND_OPTIONS: RadioCardOption<Kind>[] = [
  {
    value: "http_openapi",
    label: "APIサービス",
    description: "URLと操作（取得・登録など）を1つずつ登録します。一般的なWeb APIはこちらです。",
    icon: Globe,
  },
  {
    value: "mcp",
    label: "MCPサーバー",
    description: "インターネット上に公開されたMCPサーバーに接続します。使わせる操作だけを選びます。",
    icon: Plug,
  },
];

const RISK_OPTIONS = [
  { value: "read", label: "読み取りだけ" },
  { value: "write", label: "情報を書き換える" },
  { value: "external_send", label: "外部へ送信する" },
  { value: "financial", label: "金額を変える" },
  { value: "destructive", label: "削除する" },
] as const;

const AUTH_OPTIONS = [
  { value: "static_bearer", label: "APIキー・トークンが必要" },
  { value: "none", label: "認証は不要" },
] as const;

interface OperationDraft {
  name: string;
  displayName: string;
  description: string;
  method: string;
  path: string;
  risk: (typeof RISK_OPTIONS)[number]["value"];
  /** Agentが渡せる入力の形（JSON Schema の文字列） */
  inputSchema: string;
}

interface DiscoveredDraft {
  name: string;
  description: string;
  selected: boolean;
  /** サーバーの申告。null は申告なし */
  readOnly: boolean | null;
  destructive: boolean;
}

interface FormState {
  kind: Kind | null;
  key: string;
  name: string;
  description: string;
  baseUrl: string;
  authType: (typeof AUTH_OPTIONS)[number]["value"];
  /** 「名前: 値」を1行ずつ。APIが必須とする固定ヘッダ用 */
  headersText: string;
  operations: OperationDraft[];
  /** MCP: サーバーから取得した操作。null は未取得 */
  discovered: DiscoveredDraft[] | null;
}

const emptyOperation = (): OperationDraft => ({
  name: "",
  displayName: "",
  description: "",
  method: "GET",
  path: "",
  risk: "read",
  inputSchema: DEFAULT_INPUT_SCHEMA_TEXT,
});

function selectedOperations(form: FormState): { name: string; display_name: string; description: string; risk: OperationDraft["risk"] }[] {
  if (form.kind === "mcp" && form.discovered) {
    return form.discovered
      .filter((tool) => tool.selected)
      // 何をする操作かは接続先が決める。サーバーの申告があれば従い、無ければ安全側で記録する。
      .map((tool) => ({
        name: tool.name,
        display_name: tool.name,
        description: tool.description || tool.name,
        risk: tool.destructive ? ("destructive" as const) : tool.readOnly === true ? ("read" as const) : ("write" as const),
      }));
  }
  return form.operations.map((operation) => ({
    name: operation.name.trim(),
    display_name: operation.displayName.trim() || operation.name.trim(),
    description: operation.description.trim(),
    risk: operation.risk,
  }));
}

/** 入力の形。読めなければ省き、検証側でエラーにする */
function parseInputSchema(text: string): { input_schema?: ConnectorOperationInput["input_schema"] } {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? { input_schema: parsed as ConnectorOperationInput["input_schema"] } : {};
  } catch {
    return {};
  }
}

/** 「名前: 値」の各行を固定ヘッダにする */
function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (name && value) headers[name] = value;
  }
  return headers;
}

function buildInput(form: FormState): CreateConnectorInput | null {
  if (!form.kind) return null;
  const mcp = form.kind === "mcp";
  return {
    key: form.key.trim(),
    name: form.name.trim(),
    description: form.description.trim(),
    adapter: form.kind,
    base_url: form.baseUrl.trim(),
    auth_type: form.authType,
    ...(mcp || Object.keys(parseHeaders(form.headersText)).length === 0
      ? {}
      : { default_headers: parseHeaders(form.headersText) }),
    operations: selectedOperations(form).map((operation, index) => ({
      ...operation,
      // MCP は接続先のサーバーが操作の形式を持つため、メソッドとパスは送らない
      ...(mcp
        ? {}
        : {
            method: form.operations[index]!.method as "GET",
            path: form.operations[index]!.path.trim(),
            ...parseInputSchema(form.operations[index]!.inputSchema),
          }),
    })),
  };
}

function validate(form: FormState): { input: CreateConnectorInput | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!form.kind) {
    errors.kind = "どの方式で接続するかを選んでください";
    return { input: null, errors };
  }
  const payload = buildInput(form);
  const parsed = createConnectorSchema.safeParse(payload);
  if (!parsed.success) Object.assign(errors, zodFieldErrors(parsed.error));

  // 形式の誤りは、何を直せばよいか分かる言葉にする
  if (!form.name.trim()) errors.name = "サービス名を入力してください";
  if (!form.description.trim()) errors.description = "何に使うサービスかを入力してください";
  if (!form.key.trim()) errors.key = "識別子を入力してください";
  else if (errors.key) errors.key = "半角英小文字・数字・ハイフン（-）で入力してください（例: my-service）";
  if (!form.baseUrl.trim()) errors.base_url = form.kind === "mcp" ? "MCPサーバーのURLを入力してください" : "サービスのURLを入力してください";
  else if (errors.base_url) errors.base_url = "https:// から始まるURLを入力してください";
  if (form.kind === "mcp") {
    if (!form.discovered) errors.operations = "「接続して操作を取得」を押してください";
    else if (selectedOperations(form).length === 0) errors.operations = "使わせる操作を1つ以上選んでください";
  } else {
    if (form.operations.length === 0) errors.operations = "操作を1つ以上追加してください";
    form.operations.forEach((operation, index) => {
      if (!operation.name.trim()) errors[`operations.${index}.name`] = "操作の識別子を入力してください";
      if (!operation.description.trim()) errors[`operations.${index}.description`] = "この操作が何をするかを入力してください";
      if (!operation.path.trim()) errors[`operations.${index}.path`] = "/ から始まるパスを入力してください";
      const schemaError = inputSchemaTextError(operation.inputSchema);
      if (schemaError) errors[`operations.${index}.inputSchema`] = schemaError;
    });
  }

  const ok = parsed.success && Object.keys(errors).length === 0;
  return { input: ok && parsed.success ? parsed.data : null, errors };
}

export interface CreateConnectorDialogProps {
  /** 渡すと編集になる */
  connector?: ConnectorDto;
  onClose: () => void;
  onCreated: (connector: ConnectorDto) => void;
}

/** 既存の連携サービスを編集用の入力に戻す */
function draftFromConnector(connector: ConnectorDto): FormState {
  const kind: Kind = connector.adapter === "mcp" ? "mcp" : "http_openapi";
  const headers: Record<string, string> = {};
  const operations: OperationDraft[] = [];
  for (const tool of connector.tools) {
    const spec = tool.versions?.find((version) => version.version === tool.latest_version)?.spec;
    const fn = spec && "studio_function" in spec ? (spec.studio_function as Record<string, unknown>) : undefined;
    if (fn && typeof fn.headers === "object" && fn.headers) Object.assign(headers, fn.headers);
    operations.push({
      name: tool.name,
      displayName: tool.display_name,
      description: spec && "description" in spec ? String(spec.description) : "",
      method: typeof fn?.method === "string" ? fn.method : "GET",
      path: typeof fn?.path === "string" ? fn.path : "",
      risk: tool.risk as OperationDraft["risk"],
      inputSchema:
        spec && "input_schema" in spec ? JSON.stringify(spec.input_schema, null, 2) : DEFAULT_INPUT_SCHEMA_TEXT,
    });
  }
  return {
    kind,
    key: connector.key,
    name: connector.name,
    description: connector.description,
    baseUrl: connector.base_url ?? "",
    authType: connector.auth_type === "static_bearer" ? "static_bearer" : "none",
    headersText: Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join("\n"),
    operations: operations.length > 0 ? operations : [emptyOperation()],
    discovered:
      kind === "mcp"
        ? operations.map((operation) => ({ name: operation.name, description: operation.description, selected: true, readOnly: null, destructive: false }))
        : null,
  };
}

/** 連携サービスを自分で登録するダイアログ（開いている間だけ描画する） */
export function CreateConnectorDialog({ connector, onClose, onCreated }: CreateConnectorDialogProps) {
  const editing = Boolean(connector);
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [form, setForm] = useState<FormState>(() =>
    connector
      ? draftFromConnector(connector)
      : { kind: null, key: "", name: "", description: "", baseUrl: "", authType: "static_bearer", headersText: "", operations: [emptyOperation()], discovered: null },
  );
  const [showErrors, setShowErrors] = useState(false);
  const create = useActionMutation(createConnectorAction, {
    successMessage: (created) => `連携サービス「${created.name}」を登録しました`,
    onSuccess: (created) => onCreated(created),
  });
  const update = useActionMutation(updateConnectorAction, {
    successMessage: (updated) => `連携サービス「${updated.name}」を更新しました`,
    onSuccess: (updated) => onCreated(updated),
  });
  const mutation = editing ? update : create;

  const discover = useActionMutation(discoverMcpToolsAction, {
    successMessage: (result) => `${result.tools.length}個の操作を取得しました`,
    onSuccess: (result) =>
      setForm((prev) => ({
        ...prev,
        // 認証なしで一覧を取得できたサーバーは、そのまま認証不要として扱える
        authType: "none",
        discovered: result.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          selected: true,
          readOnly: tool.read_only,
          destructive: tool.destructive,
        })),
      })),
  });

  const validation = useMemo(() => validate(form), [form]);
  const errors = { ...mutation.fieldErrors, ...(showErrors ? validation.errors : {}) };
  const mcp = form.kind === "mcp";

  const updateForm = (patch: Partial<FormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
    if (mutation.error) mutation.reset();
  };
  const updateDiscovered = (name: string, patch: Partial<DiscoveredDraft>) => {
    setForm((prev) => ({
      ...prev,
      discovered: (prev.discovered ?? []).map((tool) => (tool.name === name ? { ...tool, ...patch } : tool)),
    }));
    if (mutation.error) mutation.reset();
  };
  const updateOperation = (index: number, patch: Partial<OperationDraft>) => {
    setForm((prev) => ({ ...prev, operations: prev.operations.map((operation, i) => (i === index ? { ...operation, ...patch } : operation)) }));
    if (mutation.error) mutation.reset();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setShowErrors(true);
    if (!validation.input) {
      requestAnimationFrame(() => {
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      });
      return;
    }
    if (editing && connector) {
      const { key: _key, adapter: _adapter, auth_type: _authType, ...rest } = validation.input;
      await update.mutate(connector.id, rest);
      return;
    }
    await create.mutate(validation.input);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      busy={mutation.pending}
      title={editing ? "連携サービスを編集" : "連携サービスを登録"}
      description={
        editing
          ? "変更は次のBuildから反映されます。公開中のAgentは作成時の内容のまま動き続けます。"
          : "Agentに使わせたいサービスを登録します。ここで登録した操作だけがAgentの候補になります。認証情報の値は、登録したあとに設定します。"
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.pending}>
            キャンセル
          </Button>
          <Button type="submit" form={formId} loading={mutation.pending}>
            {editing ? "保存" : "登録"}
          </Button>
        </>
      }
    >
      <form id={formId} ref={formRef} onSubmit={submit} className="space-y-5">
        <div>
          {editing ? null : <RadioCards legend="接続する方式" options={KIND_OPTIONS} value={form.kind} onChange={(kind) => updateForm({ kind })} />}
          {errors.kind ? <p className="mt-1 text-xs text-red-600">{errors.kind}</p> : null}
        </div>

        {form.kind ? (
          <>
            {mcp ? (
              <div className="space-y-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <p>インターネットから接続できるMCPサーバーだけが登録できます。社内ネットワークにあるサーバーは、Self-hosted Runtimeを用意してそちら側に登録してください。</p>
                <p>この方式ではOpenAIが接続先へ直接つなぐため、実行前に承認を挟めません。使わせたくない操作はチェックを外してください。</p>
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="サービス名" hint="画面に表示されます" error={errors.name}>
                <Input value={form.name} onChange={(event) => updateForm({ name: event.target.value })} placeholder="例: 社内データベース" aria-invalid={Boolean(errors.name)} />
              </Field>
              <Field label="識別子" hint={editing ? "登録後は変更できません" : "半角英小文字・数字・ハイフン"} error={errors.key}>
                <Input value={form.key} disabled={editing} onChange={(event) => updateForm({ key: event.target.value })} placeholder="例: internal-db" aria-invalid={Boolean(errors.key)} />
              </Field>
            </div>

            <Field label="どんなサービスか" hint="Agentがこのサービスを選ぶ判断に使われます" error={errors.description}>
              <Textarea
                rows={2}
                value={form.description}
                onChange={(event) => updateForm({ description: event.target.value })}
                placeholder="例: 取引先の与信情報を検索します。"
                aria-invalid={Boolean(errors.description)}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={mcp ? "MCPサーバーのURL" : "サービスのURL"} hint="https:// から始まるURL" error={errors.base_url}>
                <Input
                  value={form.baseUrl}
                  onChange={(event) => updateForm({ baseUrl: event.target.value })}
                  placeholder={mcp ? "https://mcp.example.com/mcp" : "https://api.example.com"}
                  aria-invalid={Boolean(errors.base_url)}
                />
              </Field>
              <Field label="認証" hint={mcp ? "取得できたサーバーは認証不要なことが多いです" : undefined}>
                <Select value={form.authType} onChange={(event) => updateForm({ authType: event.target.value as FormState["authType"] })}>
                  {AUTH_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {mcp ? null : (
              <Field
                label="固定ヘッダー"
                optional
                hint="APIが必須とするヘッダーがあれば「名前: 値」で1行ずつ。APIキーはここではなく認証で設定します"
                error={errors.default_headers}
              >
                <Textarea
                  rows={2}
                  value={form.headersText}
                  onChange={(event) => updateForm({ headersText: event.target.value })}
                  placeholder="Notion-Version: 2022-06-28"
                />
              </Field>
            )}

            {mcp ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  loading={discover.pending}
                  disabled={!form.baseUrl.trim()}
                  icon={<Download className="h-4 w-4" aria-hidden="true" />}
                  onClick={() => void discover.mutate({ server_url: form.baseUrl.trim() })}
                >
                  接続して操作を取得
                </Button>
                {discover.error ? <p className="text-xs text-red-600">{discover.error.message}</p> : null}
              </div>
            ) : null}

            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium text-gray-900">Agentに使わせる操作</p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {mcp ? "使わせるものだけを選びます。" : "取得と更新は別の操作として登録します。"}
                </p>
                {errors.operations ? <p className="mt-1 text-xs text-red-600">{errors.operations}</p> : null}
              </div>

              {mcp
                ? (form.discovered ?? []).map((tool) => (
                    <div key={tool.name} className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 px-3 py-2">
                      <label className="flex min-w-0 flex-1 items-start gap-2.5">
                        <input
                          type="checkbox"
                          className="mt-1 h-4 w-4 rounded border-gray-300"
                          checked={tool.selected}
                          onChange={(event) => updateDiscovered(tool.name, { selected: event.target.checked })}
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-gray-900">{tool.name}</span>
                          {tool.description ? <span className="mt-0.5 block text-xs text-gray-500">{tool.description}</span> : null}
                        </span>
                      </label>
                    </div>
                  ))
                : form.operations.map((operation, index) => (
                <div key={index} className="space-y-3 rounded-lg border border-gray-200 p-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="操作の識別子" hint={mcp ? "サーバー側の操作名" : "半角英小文字と _"} error={errors[`operations.${index}.name`]}>
                      <Input
                        value={operation.name}
                        onChange={(event) => updateOperation(index, { name: event.target.value })}
                        placeholder="例: search_company"
                        aria-invalid={Boolean(errors[`operations.${index}.name`])}
                      />
                    </Field>
                    <Field label="表示名" hint="利用者に見える名前">
                      <Input value={operation.displayName} onChange={(event) => updateOperation(index, { displayName: event.target.value })} placeholder="例: 取引先を検索" />
                    </Field>
                  </div>

                  <Field label="この操作は何をするか" error={errors[`operations.${index}.description`]}>
                    <Input
                      value={operation.description}
                      onChange={(event) => updateOperation(index, { description: event.target.value })}
                      placeholder="例: 会社名で取引先の与信情報を検索する"
                      aria-invalid={Boolean(errors[`operations.${index}.description`])}
                    />
                  </Field>

                  <div className="grid gap-3 sm:grid-cols-3">
                    {mcp ? null : (
                      <>
                        <Field label="メソッド">
                          <Select value={operation.method} onChange={(event) => updateOperation(index, { method: event.target.value })}>
                            {["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => (
                              <option key={method} value={method}>
                                {method}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="パス" hint="/ から始めます" error={errors[`operations.${index}.path`]}>
                          <Input
                            value={operation.path}
                            onChange={(event) => updateOperation(index, { path: event.target.value })}
                            placeholder="/v1/companies"
                            aria-invalid={Boolean(errors[`operations.${index}.path`])}
                          />
                        </Field>
                      </>
                    )}
                    <Field label="この操作の影響" hint="承認が必要かの判断に使います">
                      <Select value={operation.risk} onChange={(event) => updateOperation(index, { risk: event.target.value as OperationDraft["risk"] })}>
                        {RISK_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>

                  <Field
                    label="Agentが渡せる入力"
                    hint="JSON Schema。GETのクエリやPOSTの本文になります"
                    error={errors[`operations.${index}.inputSchema`]}
                  >
                    <Textarea
                      rows={4}
                      className="font-mono text-xs"
                      value={operation.inputSchema}
                      onChange={(event) => updateOperation(index, { inputSchema: event.target.value })}
                      aria-invalid={Boolean(errors[`operations.${index}.inputSchema`])}
                    />
                  </Field>

                  {form.operations.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      icon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
                      onClick={() => updateForm({ operations: form.operations.filter((_, i) => i !== index) })}
                    >
                      この操作を削除
                    </Button>
                  ) : null}
                </div>
              ))}

              {mcp ? null : (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  icon={<Plus className="h-4 w-4" aria-hidden="true" />}
                  onClick={() => updateForm({ operations: [...form.operations, emptyOperation()] })}
                >
                  操作を追加
                </Button>
              )}
            </div>
          </>
        ) : null}

        {mutation.error ? <p className="text-sm text-red-600">{mutation.error.message}</p> : null}
      </form>
    </Dialog>
  );
}
