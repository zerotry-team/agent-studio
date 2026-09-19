"use client";

import { Braces } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { inputSchemaTextError, JSON_SYNTAX_ERROR } from "./tool-spec";

export interface InputSchemaFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** 送信時の検証やサーバーから返ったエラー */
  error?: string;
  disabled?: boolean;
}

/** ツールの入力の形式（JSON Schema）を編集する。入力のたびに JSON として読めるかを確認する */
export function InputSchemaField({ value, onChange, error, disabled = false }: InputSchemaFieldProps) {
  const liveError = useMemo(() => inputSchemaTextError(value), [value]);

  const format = () => {
    try {
      onChange(JSON.stringify(JSON.parse(value), null, 2));
    } catch {
      // 形式が正しくないときはボタンを押せないので、ここには来ない
    }
  };

  return (
    <Field
      label="入力の形式（JSON Schema）"
      required
      error={liveError ?? error}
      hint={
        <>
          エージェントがこのツールに渡す値の形を、JSON Schema で書きます。いちばん外側は <code className="font-mono">&quot;type&quot;: &quot;object&quot;</code>{" "}
          にしてください。受け取る値がない場合は、このままで構いません。
        </>
      }
    >
      <Textarea
        mono
        rows={9}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoComplete="off"
        autoCapitalize="off"
      />
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={format}
          disabled={disabled || liveError === JSON_SYNTAX_ERROR}
          icon={<Braces className="h-4 w-4" aria-hidden="true" />}
        >
          整形する
        </Button>
      </div>
    </Field>
  );
}
