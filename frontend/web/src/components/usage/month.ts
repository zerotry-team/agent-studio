/** YYYY-MM の年月を扱う小さな関数（純粋関数） */

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isValidMonth(value: string): boolean {
  return MONTH_PATTERN.test(value);
}

/** 月をずらす（例: shiftMonth("2026-01", -1) → "2025-12"） */
export function shiftMonth(month: string, delta: number): string {
  const m = MONTH_PATTERN.exec(month);
  if (!m) return month;
  const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  const year = Math.floor(index / 12);
  const mon = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(mon).padStart(2, "0")}`;
}

/** 表示用（例: "2026-09" → "2026年9月"） */
export function formatMonthLabel(month: string): string {
  const m = MONTH_PATTERN.exec(month);
  if (!m) return month;
  return `${m[1]}年${Number(m[2])}月`;
}

/** 合計トークンに占める割合（0〜100）。合計が 0 のときは 0 */
export function tokenShare(tokens: number, totalTokens: number): number {
  if (totalTokens <= 0 || tokens <= 0) return 0;
  return Math.min(100, (tokens / totalTokens) * 100);
}
