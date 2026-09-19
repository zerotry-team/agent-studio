"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatMonthLabel, isValidMonth, shiftMonth } from "./month";

export interface MonthPickerProps {
  /** YYYY-MM */
  value: string;
  onChange: (month: string) => void;
  /** これより後の月は選べない（YYYY-MM） */
  max: string;
}

/** 表示する月を選ぶ（前の月・次の月のボタン付き） */
export function MonthPicker({ value, onChange, max }: MonthPickerProps) {
  // type="month" に対応していないブラウザでは文字入力になるため、入力途中の値を別に持つ
  const [draft, setDraft] = useState(value);
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setDraft(value);
  }

  const invalid = draft !== "" && !isValidMonth(draft);
  const tooLate = isValidMonth(draft) && draft > max;
  const prev = shiftMonth(value, -1);
  const next = shiftMonth(value, 1);

  const commit = (month: string) => {
    setDraft(month);
    if (isValidMonth(month) && month <= max && month !== value) onChange(month);
  };

  return (
    <Field
      label="どの月を表示しますか？"
      error={invalid ? "「2026-09」のように、年と月を入力してください" : tooLate ? "今月より後の月は選べません" : undefined}
    >
      <div className="flex gap-2">
        <div className="w-44">
          <Input type="month" value={draft} max={max} onChange={(e) => commit(e.target.value)} />
        </div>
        <Button
          variant="secondary"
          size="icon"
          onClick={() => onChange(prev)}
          aria-label={`前の月（${formatMonthLabel(prev)}）`}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button
          variant="secondary"
          size="icon"
          onClick={() => onChange(next)}
          disabled={value >= max}
          aria-label={`次の月（${formatMonthLabel(next)}）`}
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </Field>
  );
}
