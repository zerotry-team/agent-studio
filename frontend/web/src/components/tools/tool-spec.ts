import {
  inputSchemaSchema,
  type ToolExecutionLocation,
  type ToolRisk,
  type ToolVersionSpec,
} from "@agent-studio/contracts";

/**
 * ツールのバージョンの設定（spec）を編集するためのフォームの状態。
 * 実行場所ごとの項目を別々に持ち、送信時に contracts の判別可能ユニオンの形に組み立てる。
 */
export interface ToolSpecDraft {
  execution_location: ToolExecutionLocation | null;
  description: string;
  risk: ToolRisk;
  /** studio_function: 送信先 URL */
  webhookUrl: string;
  /** studio_function: 認証に使う接続先（"" は使わない） */
  webhookConnectionId: string;
  /** openai_service_mcp: サーバーの URL */
  serverUrl: string;
  /** openai_service_mcp: 使ってよいツール（1 行に 1 つ） */
  allowedTools: string;
  /** openai_service_mcp: 認証に使う接続先（"" は使わない） */
  serviceConnectionId: string;
  /** studio_function / runtime_mcp: 入力の形式（JSON Schema の文字列） */
  inputSchema: string;
  /** runtime_mcp: 信頼できない内容を読み込むか */
  readsUntrustedContent: boolean;
}

export const DEFAULT_INPUT_SCHEMA_TEXT = JSON.stringify(
  { type: "object", properties: {}, additionalProperties: false },
  null,
  2,
);

export const JSON_SYNTAX_ERROR = "JSON の形式が正しくありません";

export function emptyToolSpecDraft(location: ToolExecutionLocation | null = null): ToolSpecDraft {
  return {
    execution_location: location,
    description: "",
    risk: "read",
    webhookUrl: "",
    webhookConnectionId: "",
    serverUrl: "",
    allowedTools: "",
    serviceConnectionId: "",
    inputSchema: DEFAULT_INPUT_SCHEMA_TEXT,
    readsUntrustedContent: false,
  };
}

function schemaText(schema: unknown): string {
  return schema && typeof schema === "object" ? JSON.stringify(schema, null, 2) : DEFAULT_INPUT_SCHEMA_TEXT;
}

/** 登録済みのバージョンの設定から、フォームの初期値を作る（新しいバージョンの追加用） */
export function draftFromSpec(spec: ToolVersionSpec): ToolSpecDraft {
  const draft = emptyToolSpecDraft(spec.execution_location);
  draft.description = spec.description;
  draft.risk = spec.risk;
  switch (spec.execution_location) {
    case "studio_function":
      draft.webhookUrl = spec.studio_function.handler === "http_webhook" ? spec.studio_function.url : `${spec.studio_function.base_url}${spec.studio_function.path}`;
      draft.webhookConnectionId = spec.studio_function.handler === "http_webhook" ? (spec.studio_function.connection_id ?? "") : "";
      draft.inputSchema = schemaText(spec.input_schema);
      break;
    case "openai_service_mcp":
      draft.serverUrl = spec.service_mcp.server_url;
      draft.serviceConnectionId = spec.service_mcp.connection_id ?? "";
      draft.allowedTools = (spec.service_mcp.allowed_tools ?? []).join("\n");
      break;
    case "runtime_mcp":
      draft.inputSchema = schemaText(spec.input_schema);
      draft.readsUntrustedContent = spec.reads_untrusted_content ?? false;
      break;
  }
  return draft;
}

/**
 * 入力の形式（JSON Schema）の文字列を確認する。
 * 問題がなければ null、問題があれば利用者に見せるメッセージを返す。
 */
export function inputSchemaTextError(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return JSON_SYNTAX_ERROR;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as { type?: unknown }).type !== "object") {
    return "いちばん外側は {\"type\": \"object\", ...} の形にしてください";
  }
  const result = inputSchemaSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.map(String).join(".");
    return issue ? (path ? `${path}: ${issue.message}` : issue.message) : JSON_SYNTAX_ERROR;
  }
  return null;
}

function linesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * フォームの状態から、API に送る spec（判別可能ユニオン）を組み立てる。
 * 実行場所に関係のない項目は含めない。組み立てる前に分かる問題は errors（spec からのパス）に入れる。
 * 戻り値の spec は contracts のスキーマで検証してから送る。
 */
export function buildToolSpec(draft: ToolSpecDraft): { spec: Record<string, unknown> | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const location = draft.execution_location;
  if (!location) {
    errors.execution_location = "このツールがどこで動くかを選んでください";
    return { spec: null, errors };
  }

  const common = { execution_location: location, description: draft.description.trim(), risk: draft.risk };
  if (!common.description) errors.description = "説明を入力してください";

  if (location === "openai_service_mcp") {
    if (!draft.serverUrl.trim()) errors["service_mcp.server_url"] = "サーバーの URL を入力してください";
    const allowed = linesOf(draft.allowedTools);
    const serviceMcp: Record<string, unknown> = { server_url: draft.serverUrl.trim() };
    if (draft.serviceConnectionId) serviceMcp.connection_id = draft.serviceConnectionId;
    if (allowed.length > 0) serviceMcp.allowed_tools = allowed;
    return { spec: { ...common, service_mcp: serviceMcp }, errors };
  }

  const schemaError = inputSchemaTextError(draft.inputSchema);
  if (schemaError) errors.input_schema = schemaError;
  const inputSchema = schemaError ? undefined : parseJsonOrUndefined(draft.inputSchema);

  if (location === "studio_function") {
    if (!draft.webhookUrl.trim()) errors["studio_function.url"] = "送信先 URL を入力してください";
    const studioFunction: Record<string, unknown> = { handler: "http_webhook", url: draft.webhookUrl.trim() };
    if (draft.webhookConnectionId) studioFunction.connection_id = draft.webhookConnectionId;
    const spec: Record<string, unknown> = { ...common, studio_function: studioFunction };
    if (inputSchema !== undefined) spec.input_schema = inputSchema;
    return { spec, errors };
  }

  const spec: Record<string, unknown> = { ...common, reads_untrusted_content: draft.readsUntrustedContent };
  if (inputSchema !== undefined) spec.input_schema = inputSchema;
  return { spec, errors };
}

/** "spec.xxx" の形のエラーのキーから "spec." を取り除く（フォームは spec からのパスで表示する） */
export function specRelativeErrors(errors: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, message] of Object.entries(errors)) {
    if (key === "spec") out[""] = message;
    else if (key.startsWith("spec.")) out[key.slice("spec.".length)] = message;
  }
  return out;
}

/** パスそのもの、またはその下の項目のエラーのうち最初のもの */
export function errorAt(errors: Record<string, string>, path: string): string | undefined {
  if (errors[path]) return errors[path];
  const prefix = `${path}.`;
  for (const [key, message] of Object.entries(errors)) {
    if (key.startsWith(prefix)) return message;
  }
  return undefined;
}
