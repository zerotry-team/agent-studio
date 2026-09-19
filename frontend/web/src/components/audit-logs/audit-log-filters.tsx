"use client";

import { Search } from "lucide-react";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { ACTOR_TYPE_LABELS, AUDIT_RESULT } from "@/lib/utils/labels";
import type { ActorTypeFilter, AuditLogFilters, ResultFilter } from "./audit-log-filter";

const ACTOR_TYPES = ["user", "runtime", "system"] as const;
const RESULTS = ["success", "failure", "denied"] as const;

export function AuditLogFiltersForm({ value, onChange }: { value: AuditLogFilters; onChange: (next: AuditLogFilters) => void }) {
  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="検索" className="sm:col-span-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden="true" />
            <Input
              type="search"
              value={value.query}
              onChange={(e) => onChange({ ...value, query: e.target.value })}
              placeholder="操作・対象・実行者で探す（例: agent.create）"
              className="pl-9"
              autoComplete="off"
            />
          </div>
        </Field>
        <Field label="実行者の種類">
          <Select value={value.actorType} onChange={(e) => onChange({ ...value, actorType: e.target.value as ActorTypeFilter })}>
            <option value="all">すべて</option>
            {ACTOR_TYPES.map((t) => (
              <option key={t} value={t}>
                {ACTOR_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="結果">
          <Select value={value.result} onChange={(e) => onChange({ ...value, result: e.target.value as ResultFilter })}>
            <option value="all">すべて</option>
            {RESULTS.map((r) => (
              <option key={r} value={r}>
                {AUDIT_RESULT[r].label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <p className="text-xs text-gray-500">読み込み済みの記録の中から絞り込みます。</p>
    </div>
  );
}
