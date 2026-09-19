const TIME_ZONE = "Asia/Tokyo";

const dateTimeFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const dateTimeSecondsFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: TIME_ZONE,
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const numberFormatter = new Intl.NumberFormat("ja-JP");

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 例: 2026/09/19 15:30 */
export function formatDateTime(value: string | Date | null | undefined, fallback = "—"): string {
  const d = toDate(value);
  return d ? dateTimeFormatter.format(d) : fallback;
}

/** 例: 09/19 15:30:12（イベントのタイムライン用） */
export function formatTime(value: string | Date | null | undefined, fallback = "—"): string {
  const d = toDate(value);
  return d ? dateTimeSecondsFormatter.format(d) : fallback;
}

/** 例: 3分前 / 2時間後 */
export function formatRelative(value: string | Date | null | undefined, now: Date = new Date(), fallback = "—"): string {
  const d = toDate(value);
  if (!d) return fallback;
  const diffSeconds = Math.round((d.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(diffSeconds);
  const suffix = diffSeconds < 0 ? "前" : "後";
  if (abs < 45) return diffSeconds < 0 ? "たった今" : "まもなく";
  if (abs < 60 * 60) return `${Math.round(abs / 60)}分${suffix}`;
  if (abs < 60 * 60 * 24) return `${Math.round(abs / 3600)}時間${suffix}`;
  if (abs < 60 * 60 * 24 * 30) return `${Math.round(abs / 86400)}日${suffix}`;
  return formatDateTime(d);
}

/** 例: 1分23秒 */
export function formatDuration(start: string | null | undefined, end: string | null | undefined): string {
  const s = toDate(start);
  const e = toDate(end);
  if (!s || !e) return "—";
  const total = Math.max(0, Math.round((e.getTime() - s.getTime()) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}時間${m}分`;
  if (m > 0) return `${m}分${sec}秒`;
  return `${sec}秒`;
}

export function formatNumber(value: number | null | undefined, fallback = "—"): string {
  return typeof value === "number" && Number.isFinite(value) ? numberFormatter.format(value) : fallback;
}

/** 文字列が JSON ならきれいに整形する。JSON でなければそのまま返す */
export function prettyJson(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 長い ID を短く表示する（例: 1a2b3c4d…） */
export function shortId(id: string | null | undefined, length = 8): string {
  if (!id) return "—";
  return id.length > length ? `${id.slice(0, length)}…` : id;
}

/** 今月（Asia/Tokyo）の YYYY-MM */
export function currentMonth(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit" }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value ?? String(now.getFullYear());
  const m = parts.find((p) => p.type === "month")?.value ?? String(now.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
