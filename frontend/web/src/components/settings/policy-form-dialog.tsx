"use client";

import type { PolicyDto } from "@agent-studio/contracts";
import { Ban, Clock, Gauge, Plus, ShieldCheck, type LucideIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { createPolicyAction } from "@/actions/policies";
import { listToolsAction } from "@/actions/tools";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { RadioCards } from "@/components/ui/radio-cards";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import { POLICY_TYPE_DESCRIPTIONS, POLICY_TYPE_LABELS } from "@/lib/utils/labels";
import { ConditionBuilder } from "./condition-builder";
import { describePolicy } from "./policy-describe";
import {
  ALL_TOOLS,
  DEFAULT_TIMEOUT_MINUTES,
  POLICY_TYPES,
  initialPolicyFormState,
  previewPolicyRule,
  validatePolicyForm,
  type PolicyFormState,
  type PolicyType,
} from "./policy-form-model";

const TYPE_ICONS: Record<PolicyType, LucideIcon> = {
  approval: ShieldCheck,
  deny: Ban,
  rate_limit: Gauge,
  time_window: Clock,
};

const TIMEZONES: { value: string; label: string }[] = [
  { value: "Asia/Tokyo", label: "日本時間（Asia/Tokyo）" },
  { value: "UTC", label: "協定世界時（UTC）" },
  { value: "Asia/Seoul", label: "韓国時間（Asia/Seoul）" },
  { value: "Asia/Shanghai", label: "中国時間（Asia/Shanghai）" },
  { value: "Asia/Singapore", label: "シンガポール時間（Asia/Singapore）" },
  { value: "Europe/London", label: "イギリス時間（Europe/London）" },
  { value: "America/New_York", label: "アメリカ東部時間（America/New_York）" },
  { value: "America/Los_Angeles", label: "アメリカ太平洋時間（America/Los_Angeles）" },
];

const START_HOURS = Array.from({ length: 24 }, (_, h) => h); // 0〜23
const END_HOURS = Array.from({ length: 24 }, (_, h) => h + 1); // 1〜24

/** フォームの項目として表示しているエラーのパス（これ以外は上部にまとめて表示する） */
const FIELD_PATHS = new Set([
  "name",
  "rule.type",
  "rule.tool",
  "rule.timeout_minutes",
  "rule.reason",
  "rule.max_calls_per_session",
  "rule.timezone",
  "rule.start_hour",
  "rule.end_hour",
  "rule.weekdays_only",
]);

/** フォームの項目 → その項目を変えたときに消すエラーのパス */
const ERROR_PATHS_BY_FIELD: Record<keyof PolicyFormState, readonly string[]> = {
  name: ["name"],
  type: ["rule"],
  tool: ["rule.tool"],
  condition: ["rule.when"],
  timeoutMinutes: ["rule.timeout_minutes"],
  reason: ["rule.reason"],
  maxCalls: ["rule.max_calls_per_session"],
  timezone: ["rule.timezone"],
  startHour: ["rule.start_hour", "rule.end_hour"],
  endHour: ["rule.start_hour", "rule.end_hour"],
  weekdaysOnly: ["rule.weekdays_only"],
};

export interface CreatePolicyDialogProps {
  onClose: () => void;
  onCreated: (policy: PolicyDto) => void;
}

/** 組織全体のポリシーを追加するダイアログ（開くたびにマウントして、入力を初期状態に戻す） */
export function CreatePolicyDialog({ onClose, onCreated }: CreatePolicyDialogProps) {
  const { organization } = useSession();
  const formId = useId();
  const [form, setForm] = useState<PolicyFormState>(initialPolicyFormState);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const tools = useActionQuery(() => listToolsAction(), [organization?.id]);
  const mutation = useActionMutation(createPolicyAction, {
    successMessage: (p) => `ポリシー「${p.name}」を追加しました`,
    onSuccess: (policy) => {
      onCreated(policy);
      onClose();
    },
  });

  const set = <K extends keyof PolicyFormState>(key: K, value: PolicyFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    // 変更した項目のエラーは消す（条件の行が増減すると位置がずれるため、条件のエラーはまとめて消す）
    const prefixes = ERROR_PATHS_BY_FIELD[key];
    setErrors((prev) => {
      const entries = Object.entries(prev).filter(([path]) => !prefixes.some((p) => path === p || path.startsWith(`${p}.`)));
      return entries.length === Object.keys(prev).length ? prev : Object.fromEntries(entries);
    });
  };

  const allErrors = { ...mutation.fieldErrors, ...errors };
  const error = (path: string) => allErrors[path];
  const otherErrors = Object.entries(allErrors).filter(
    ([key]) => !FIELD_PATHS.has(key) && key !== "rule" && !key.startsWith("rule.when"),
  );

  const preview = useMemo(() => previewPolicyRule(form), [form]);

  const toolOptions = useMemo(() => {
    const list = [...(tools.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    const options = list.map((t) => ({
      value: t.name,
      label: t.display_name && t.display_name !== t.name ? `${t.display_name}（${t.name}）` : t.name,
    }));
    if (form.tool !== ALL_TOOLS && !options.some((o) => o.value === form.tool)) {
      options.unshift({ value: form.tool, label: form.tool });
    }
    return options;
  }, [tools.data, form.tool]);

  const timezoneOptions = TIMEZONES.some((t) => t.value === form.timezone)
    ? TIMEZONES
    : [{ value: form.timezone, label: form.timezone }, ...TIMEZONES];

  const submit = async () => {
    const result = validatePolicyForm(form);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    mutation.reset();
    await mutation.mutate(result.input);
  };

  const usesCondition = form.type === "approval" || form.type === "deny";

  return (
    <Dialog
      open
      onClose={onClose}
      busy={mutation.pending}
      size="lg"
      title="ポリシーを追加"
      description="組織のすべてのエージェントに適用するルールです。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.pending}>
            キャンセル
          </Button>
          <Button type="submit" form={formId} loading={mutation.pending} icon={<Plus className="h-4 w-4" aria-hidden="true" />}>
            追加する
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="space-y-6"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {otherErrors.length > 0 || allErrors.rule ? (
          <Alert tone="danger" title="入力内容を確認してください">
            <ul className="list-disc space-y-0.5 pl-4">
              {allErrors.rule ? <li>{allErrors.rule}</li> : null}
              {otherErrors.map(([key, message]) => (
                <li key={key}>{message}</li>
              ))}
            </ul>
          </Alert>
        ) : null}

        <Field label="名前" required error={error("name")} hint="一覧で見分けるための名前です（例: 大きな値引きは承認が必要）">
          <Input value={form.name} maxLength={100} onChange={(e) => set("name", e.target.value)} data-autofocus />
        </Field>

        <RadioCards<PolicyType>
          legend="どんなルールにしますか？"
          columns={2}
          value={form.type}
          onChange={(type) => set("type", type)}
          error={error("rule.type")}
          options={POLICY_TYPES.map((type) => ({
            value: type,
            label: POLICY_TYPE_LABELS[type],
            description: POLICY_TYPE_DESCRIPTIONS[type],
            icon: TYPE_ICONS[type],
          }))}
        />

        <Field
          label="対象のツール"
          required
          error={error("rule.tool")}
          hint={
            tools.error
              ? "ツールの一覧を読み込めませんでした。「すべてのツール」だけを選べます。"
              : tools.loading
                ? "ツールの一覧を読み込んでいます…"
                : "登録済みのツールから選びます。"
          }
        >
          <Select value={form.tool} onChange={(e) => set("tool", e.target.value)}>
            <option value={ALL_TOOLS}>すべてのツール（*）</option>
            {toolOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>

        {usesCondition ? (
          <ConditionBuilder value={form.condition} onChange={(condition) => set("condition", condition)} errors={allErrors} />
        ) : null}

        {form.type === "approval" ? (
          <Field
            label="承認の期限（分）"
            error={error("rule.timeout_minutes")}
            hint={`この時間までに承認されないと、却下として扱います。1〜10080 分（7 日）で指定します。空欄なら ${DEFAULT_TIMEOUT_MINUTES} 分（1 日）です。`}
            className="max-w-xs"
          >
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={10080}
              step={1}
              value={form.timeoutMinutes}
              onChange={(e) => set("timeoutMinutes", e.target.value)}
            />
          </Field>
        ) : null}

        {usesCondition ? (
          <Field
            label="理由"
            optional
            error={error("rule.reason")}
            hint={
              form.type === "approval"
                ? "承認者に表示されます。なぜ承認が必要なのかを書いておくと、判断しやすくなります。"
                : "禁止した理由として表示されます。"
            }
          >
            <Textarea rows={2} maxLength={500} value={form.reason} onChange={(e) => set("reason", e.target.value)} />
          </Field>
        ) : null}

        {form.type === "rate_limit" ? (
          <Field
            label="1回の実行で呼び出せる回数"
            required
            error={error("rule.max_calls_per_session")}
            hint="この回数を超えて呼び出そうとすると、禁止されます。1〜10000 回で指定します。"
            className="max-w-xs"
          >
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={10000}
              step={1}
              value={form.maxCalls}
              onChange={(e) => set("maxCalls", e.target.value)}
            />
          </Field>
        ) : null}

        {form.type === "time_window" ? (
          <div className="space-y-4">
            <Field label="タイムゾーン" error={error("rule.timezone")} className="max-w-md">
              <Select value={form.timezone} onChange={(e) => set("timezone", e.target.value)}>
                {timezoneOptions.map((tz) => (
                  <option key={tz.value} value={tz.value}>
                    {tz.label}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid max-w-md grid-cols-2 gap-3">
              <Field label="開始時刻" error={error("rule.start_hour")}>
                <Select value={form.startHour} onChange={(e) => set("startHour", Number(e.target.value))}>
                  {START_HOURS.map((h) => (
                    <option key={h} value={h}>
                      {h}時
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="終了時刻" error={error("rule.end_hour")}>
                <Select value={form.endHour} onChange={(e) => set("endHour", Number(e.target.value))}>
                  {END_HOURS.map((h) => (
                    <option key={h} value={h}>
                      {h === 24 ? "24時（深夜0時）" : `${h}時`}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <p className="-mt-1 text-xs leading-relaxed text-gray-500">
              終了時刻ちょうどからは使えません。開始より前の終了時刻を選ぶと、日をまたぐ時間帯（例: 22時〜翌6時）になります。
            </p>
            <Checkbox
              label="平日だけ"
              description="土曜日と日曜日は使えないようにします（祝日は区別しません）。"
              checked={form.weekdaysOnly}
              onChange={(e) => set("weekdaysOnly", e.target.checked)}
            />
          </div>
        ) : null}

        <div className="rounded-lg border border-accent-100 bg-accent-50/50 px-4 py-3">
          <p className="text-xs font-medium text-accent-700">このポリシーの内容</p>
          <p className="mt-1 text-sm leading-relaxed text-gray-900">
            {preview ? describePolicy(preview) : "必要な項目を入力すると、ここに内容が表示されます。"}
          </p>
        </div>
      </form>
    </Dialog>
  );
}
