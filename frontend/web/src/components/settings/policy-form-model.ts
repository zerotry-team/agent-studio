import {
  createPolicySchema,
  type Comparison,
  type Condition,
  type CreatePolicyInput,
  type Policy,
  type PolicyInput,
} from "@agent-studio/contracts";
import { zodFieldErrors } from "@/lib/utils/zod-ja";

/**
 * 「ポリシーを追加」フォームの状態と、そこから policySchema どおりの rule を組み立てる純粋関数。
 * 画面（policy-form-dialog.tsx / condition-builder.tsx）はこのモジュールを通して rule を作る。
 */

export type PolicyType = Policy["type"];
export type ComparisonOp = Comparison["op"];
/** 条件を付けるか: なし / 1つ / すべて満たす（all）/ いずれかを満たす（any） */
export type ConditionMode = "none" | "single" | "all" | "any";

export const POLICY_TYPES: readonly PolicyType[] = ["approval", "deny", "rate_limit", "time_window"];
export const COMPARISON_OPS: readonly ComparisonOp[] = [">", ">=", "<", "<=", "==", "!=", "in", "not_in"];
/** 数値でしか比べられない比べ方 */
export const NUMERIC_OPS: ReadonlySet<ComparisonOp> = new Set<ComparisonOp>([">", ">=", "<", "<="]);
/** 値を複数（カンマ区切り）で指定する比べ方 */
export const LIST_OPS: ReadonlySet<ComparisonOp> = new Set<ComparisonOp>(["in", "not_in"]);
export const MAX_CONDITION_ROWS = 16;
export const DEFAULT_TIMEOUT_MINUTES = 1440;
export const ALL_TOOLS = "*";

const FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const NUMERIC_PATTERN = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

export interface ConditionRowState {
  /** React の key 用（API には送らない） */
  key: string;
  field: string;
  op: ComparisonOp;
  /** 入力されたままの文字列。送信時に数値・真偽値・配列に変換する */
  value: string;
  abs: boolean;
}

export interface ConditionState {
  mode: ConditionMode;
  rows: ConditionRowState[];
}

export interface PolicyFormState {
  name: string;
  type: PolicyType;
  /** ツール名、または "*"（すべてのツール） */
  tool: string;
  condition: ConditionState;
  timeoutMinutes: string;
  reason: string;
  maxCalls: string;
  timezone: string;
  startHour: number;
  endHour: number;
  weekdaysOnly: boolean;
}

let rowSeq = 0;

export function newConditionRow(partial: Partial<Omit<ConditionRowState, "key">> = {}): ConditionRowState {
  rowSeq += 1;
  return { key: `condition-row-${rowSeq}`, field: "", op: ">", value: "", abs: false, ...partial };
}

export function initialConditionState(): ConditionState {
  return { mode: "none", rows: [newConditionRow()] };
}

export function initialPolicyFormState(): PolicyFormState {
  return {
    name: "",
    type: "approval",
    tool: ALL_TOOLS,
    condition: initialConditionState(),
    timeoutMinutes: String(DEFAULT_TIMEOUT_MINUTES),
    reason: "",
    maxCalls: "10",
    timezone: "Asia/Tokyo",
    startHour: 9,
    endHour: 18,
    weekdaysOnly: true,
  };
}

/** 条件の付け方を変える。行が無くなっていれば空の行を 1 つ用意する（入力済みの行は残す） */
export function setConditionMode(state: ConditionState, mode: ConditionMode): ConditionState {
  return { mode, rows: state.rows.length > 0 ? state.rows : [newConditionRow()] };
}

/** 画面に表示し、rule に含める行 */
export function activeRows(state: ConditionState): ConditionRowState[] {
  if (state.mode === "none") return [];
  if (state.mode === "single") return state.rows.slice(0, 1);
  return state.rows.slice(0, MAX_CONDITION_ROWS);
}

/** 行のエラーのキーの接頭辞（例: "rule.when"、"rule.when.all.0"） */
export function conditionRowPath(mode: ConditionMode, index: number, prefix = "rule.when"): string {
  return mode === "single" ? prefix : `${prefix}.${mode}.${index}`;
}

/** 全角の数字なども数値として扱う（文字列そのものは変えない） */
function asNumber(raw: string): number | undefined {
  const normalized = raw.trim().normalize("NFKC");
  return NUMERIC_PATTERN.test(normalized) ? Number(normalized) : undefined;
}

function parseScalar(raw: string): string | number | boolean {
  const s = raw.trim();
  const n = asNumber(s);
  if (n !== undefined) return n;
  if (s === "true") return true;
  if (s === "false") return false;
  return s;
}

/**
 * 入力された値を比較の値に変換する。
 * - 次のいずれか / いずれでもない: カンマ（, 、 ，）区切りの配列。数値にできる要素は数値にする
 * - それ以外: 数値にできれば数値、"true" / "false" は真偽値、それ以外は文字列
 */
export function parseConditionValue(op: ComparisonOp, raw: string): Comparison["value"] {
  if (LIST_OPS.has(op)) {
    return raw
      .split(/[,、，]/)
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .map((s) => asNumber(s) ?? s);
  }
  return parseScalar(raw);
}

export function buildComparison(row: ConditionRowState): Comparison {
  const comparison: Comparison = { field: row.field.trim(), op: row.op, value: parseConditionValue(row.op, row.value) };
  if (row.abs && !LIST_OPS.has(row.op)) comparison.abs = true;
  return comparison;
}

export function buildCondition(state: ConditionState): Condition | undefined {
  const comparisons = activeRows(state).map(buildComparison);
  switch (state.mode) {
    case "none":
      return undefined;
    case "single":
      return comparisons[0];
    case "all":
      return { all: comparisons };
    case "any":
      return { any: comparisons };
  }
}

/** 空欄なら undefined（既定値を使う）。数値にできなければ NaN（検証でエラーになる） */
function toOptionalNumber(raw: string): number | undefined {
  const s = raw.trim();
  if (s === "") return undefined;
  return asNumber(s) ?? Number.NaN;
}

/** フォームの状態から rule を組み立てる（検証はしない） */
export function buildPolicyRule(state: PolicyFormState): PolicyInput {
  const tool = state.tool;
  const reason = state.reason.trim();
  switch (state.type) {
    case "approval": {
      const when = buildCondition(state.condition);
      const timeout = toOptionalNumber(state.timeoutMinutes);
      return {
        type: "approval",
        tool,
        ...(when ? { when } : {}),
        ...(timeout !== undefined ? { timeout_minutes: timeout } : {}),
        ...(reason ? { reason } : {}),
      };
    }
    case "deny": {
      const when = buildCondition(state.condition);
      return { type: "deny", tool, ...(when ? { when } : {}), ...(reason ? { reason } : {}) };
    }
    case "rate_limit":
      return { type: "rate_limit", tool, max_calls_per_session: toOptionalNumber(state.maxCalls) ?? Number.NaN };
    case "time_window":
      return {
        type: "time_window",
        tool,
        timezone: state.timezone.trim() || "Asia/Tokyo",
        start_hour: state.startHour,
        end_hour: state.endHour,
        weekdays_only: state.weekdaysOnly,
      };
  }
}

export function buildCreatePolicyInput(state: PolicyFormState): CreatePolicyInput {
  return { name: state.name.trim(), rule: buildPolicyRule(state), enabled: true };
}

/** 条件の行ごとの分かりやすいチェック（スキーマより先に、具体的なメッセージを出す） */
function validateConditionRows(state: ConditionState): Record<string, string> {
  const errors: Record<string, string> = {};
  activeRows(state).forEach((row, index) => {
    const path = conditionRowPath(state.mode, index);
    const field = row.field.trim();
    if (field === "") {
      errors[`${path}.field`] = "引数の名前を入力してください";
    } else if (!FIELD_PATTERN.test(field)) {
      errors[`${path}.field`] = "半角英数字とアンダースコアで入力してください（例: price_change、customer.rank）";
    }
    const value = parseConditionValue(row.op, row.value);
    if (Array.isArray(value)) {
      if (value.length === 0) errors[`${path}.value`] = "値を1つ以上入力してください（カンマ区切り）";
    } else if (row.value.trim() === "") {
      errors[`${path}.value`] = "値を入力してください";
    } else if (NUMERIC_OPS.has(row.op) && typeof value !== "number") {
      errors[`${path}.value`] = "この比べ方では数値を入力してください";
    }
  });
  return errors;
}

export type PolicyFormValidation =
  | { ok: true; input: CreatePolicyInput; rule: Policy }
  | { ok: false; errors: Record<string, string> };

/**
 * フォームを検証して、送信できる入力を返す。
 * エラーのキーは createPolicySchema のパス（例: "name"、"rule.when.all.0.field"）。
 */
export function validatePolicyForm(state: PolicyFormState): PolicyFormValidation {
  const errors: Record<string, string> = {};
  if (state.type === "approval" || state.type === "deny") {
    Object.assign(errors, validateConditionRows(state.condition));
  }
  if (state.type === "time_window" && state.startHour === state.endHour) {
    errors["rule.end_hour"] = "開始時刻とは別の時刻を選んでください";
  }

  const parsed = createPolicySchema.safeParse(buildCreatePolicyInput(state));
  if (!parsed.success) {
    for (const [key, message] of Object.entries(zodFieldErrors(parsed.error))) {
      if (!(key in errors)) errors[key] = message;
    }
  }
  if (!parsed.success || Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, input: parsed.data, rule: parsed.data.rule };
}

/** 入力途中のプレビュー用。組み立てた rule が正しければ返す */
export function previewPolicyRule(state: PolicyFormState): Policy | null {
  const result = validatePolicyForm({ ...state, name: state.name.trim() || "preview" });
  return result.ok ? result.rule : null;
}
