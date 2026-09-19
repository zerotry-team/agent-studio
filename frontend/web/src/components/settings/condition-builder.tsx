"use client";

import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { RadioCards } from "@/components/ui/radio-cards";
import { CONDITION_OP_LABELS } from "@/lib/utils/labels";
import {
  COMPARISON_OPS,
  LIST_OPS,
  MAX_CONDITION_ROWS,
  NUMERIC_OPS,
  activeRows,
  conditionRowPath,
  newConditionRow,
  setConditionMode,
  type ComparisonOp,
  type ConditionMode,
  type ConditionRowState,
  type ConditionState,
} from "./policy-form-model";

const MODE_OPTIONS: { value: ConditionMode; label: string; description: string }[] = [
  { value: "none", label: "条件なし（常に）", description: "このツールを呼び出すたびに適用します" },
  { value: "single", label: "1つの条件", description: "引数の値が条件に当てはまるときだけ適用します" },
  { value: "all", label: "すべての条件を満たすとき", description: "複数の条件を、すべて満たしたときだけ適用します" },
  { value: "any", label: "いずれかの条件を満たすとき", description: "複数の条件のうち、1つでも満たしたら適用します" },
];

function valuePlaceholder(op: ComparisonOp): string {
  if (LIST_OPS.has(op)) return "例: gold, silver";
  if (NUMERIC_OPS.has(op)) return "例: 500";
  return "例: 500 / true / gold";
}

export interface ConditionBuilderProps {
  value: ConditionState;
  onChange: (next: ConditionState) => void;
  /** キーは createPolicySchema のパス（例: "rule.when.all.0.field"） */
  errors: Record<string, string>;
  /** 条件のパス（既定 "rule.when"） */
  pathPrefix?: string;
}

/** ポリシーの条件（when）を、自由記述ではなく項目を選んで組み立てる */
export function ConditionBuilder({ value, onChange, errors, pathPrefix = "rule.when" }: ConditionBuilderProps) {
  const rows = activeRows(value);
  const multiple = value.mode === "all" || value.mode === "any";

  const updateRow = (key: string, patch: Partial<Omit<ConditionRowState, "key">>) => {
    onChange({ ...value, rows: value.rows.map((row) => (row.key === key ? { ...row, ...patch } : row)) });
  };
  const removeRow = (key: string) => {
    const next = value.rows.filter((row) => row.key !== key);
    onChange({ ...value, rows: next.length > 0 ? next : [newConditionRow()] });
  };
  const addRow = () => {
    if (value.rows.length >= MAX_CONDITION_ROWS) return;
    onChange({ ...value, rows: [...value.rows, newConditionRow()] });
  };

  // 行の項目に対応しない、条件全体のエラー（件数の上限など）
  const rowFieldKeys = new Set(
    rows.flatMap((_, i) => ["field", "op", "value", "abs"].map((k) => `${conditionRowPath(value.mode, i, pathPrefix)}.${k}`)),
  );
  const generalError =
    value.mode === "none"
      ? undefined
      : Object.entries(errors).find(([key]) => (key === pathPrefix || key.startsWith(`${pathPrefix}.`)) && !rowFieldKeys.has(key))?.[1];

  return (
    <div className="space-y-4">
      <RadioCards<ConditionMode>
        legend="条件を付けますか？"
        description="ツールに渡される引数の値によって、このルールを適用するかどうかを決められます。"
        columns={2}
        value={value.mode}
        onChange={(mode) => onChange(setConditionMode(value, mode))}
        options={MODE_OPTIONS}
      />

      {value.mode !== "none" ? (
        <div className="space-y-3">
          {rows.map((row, index) => {
            const path = conditionRowPath(value.mode, index, pathPrefix);
            const isList = LIST_OPS.has(row.op);
            return (
              <fieldset key={row.key} className="relative rounded-lg border border-gray-200 bg-gray-50/60 p-4">
                {/* float させると legend を枠の内側に表示できる */}
                <legend className="float-left mb-3 text-sm font-medium text-gray-800">
                  {multiple ? `条件 ${index + 1}` : "条件"}
                </legend>
                {multiple && rows.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="absolute right-2 top-2"
                    onClick={() => removeRow(row.key)}
                    aria-label={`条件 ${index + 1} を削除`}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
                ) : null}
                <div className="clear-both grid gap-3 sm:grid-cols-12">
                  <Field label="引数の名前" error={errors[`${path}.field`]} className="sm:col-span-5">
                    <Input
                      value={row.field}
                      onChange={(e) => updateRow(row.key, { field: e.target.value })}
                      placeholder="例: price_change"
                      autoComplete="off"
                      spellCheck={false}
                      className="font-mono"
                    />
                  </Field>
                  <Field label="比べ方" error={errors[`${path}.op`]} className="sm:col-span-3">
                    <Select value={row.op} onChange={(e) => updateRow(row.key, { op: e.target.value as ComparisonOp })}>
                      {COMPARISON_OPS.map((op) => (
                        <option key={op} value={op}>
                          {CONDITION_OP_LABELS[op] ?? op}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field
                    label="値"
                    hint={isList ? "カンマ区切りで複数入力できます" : undefined}
                    error={errors[`${path}.value`]}
                    className="sm:col-span-4"
                  >
                    <Input
                      value={row.value}
                      onChange={(e) => updateRow(row.key, { value: e.target.value })}
                      placeholder={valuePlaceholder(row.op)}
                      autoComplete="off"
                      inputMode={NUMERIC_OPS.has(row.op) ? "decimal" : undefined}
                    />
                  </Field>
                </div>
                {!isList ? (
                  <Checkbox
                    className="mt-3"
                    label="絶対値で比べる"
                    description="値下げ（マイナス）と値上げを同じ基準で扱います。"
                    checked={row.abs}
                    onChange={(e) => updateRow(row.key, { abs: e.target.checked })}
                  />
                ) : null}
              </fieldset>
            );
          })}

          {multiple ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={addRow}
                disabled={value.rows.length >= MAX_CONDITION_ROWS}
                icon={<Plus className="h-4 w-4" aria-hidden="true" />}
              >
                条件を追加
              </Button>
              <span className="text-xs text-gray-500">最大 {MAX_CONDITION_ROWS} 個まで</span>
            </div>
          ) : null}

          {generalError ? (
            <p className="text-xs font-medium text-red-600" role="alert">
              {generalError}
            </p>
          ) : null}

          <p className="text-xs leading-relaxed text-gray-500">
            引数の名前は、ツールに渡される値の名前です。入れ子の値は customer.rank のように「.」でつなぎます。
            引数が無いなどで判定できないときは、安全のため条件に当てはまるものとして扱います。
          </p>
        </div>
      ) : null}
    </div>
  );
}
