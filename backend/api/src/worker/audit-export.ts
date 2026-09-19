import type { Deps } from "../application/deps.js";

const HOUR_MS = 60 * 60 * 1000;
/** 書き込みが落ち着くまで待ってから書き出す */
const SETTLE_MS = 5 * 60 * 1000;
const LOOKBACK_HOURS = 48;

const pad = (n: number) => String(n).padStart(2, "0");

/** audit-logs/YYYY/MM/DD/HH.jsonl（UTC の1時間ごと） */
export function auditExportKey(hourStart: Date): string {
  return `audit-logs/${hourStart.getUTCFullYear()}/${pad(hourStart.getUTCMonth() + 1)}/${pad(hourStart.getUTCDate())}/${pad(hourStart.getUTCHours())}.jsonl`;
}

/**
 * 監査ログを1時間ごとに S3（Object Lock・ガバナンスモード）へ書き出す（AUD-03）。
 * DB の監査ログはアプリから書き換えられないが、運用者（DB の所有者）からも改ざんされないよう、変更できない場所に写しを残す。
 * すでに書き出した時間帯は飛ばす（複数の Worker が同時に動いても同じ内容になる）。
 */
export class AuditExporter {
  constructor(private readonly deps: Deps) {}

  async tick(now = new Date()): Promise<void> {
    const bucket = this.deps.env.AUDIT_EXPORT_BUCKET;
    if (!bucket) return;
    const lastComplete = Math.floor((now.getTime() - SETTLE_MS) / HOUR_MS) * HOUR_MS - HOUR_MS;
    for (let t = lastComplete; t > lastComplete - LOOKBACK_HOURS * HOUR_MS; t -= HOUR_MS) {
      const from = new Date(t);
      const key = auditExportKey(from);
      if (await this.deps.objects.exists(bucket, key)) continue;
      const rows = await this.deps.system.exportAuditLogs(from, new Date(t + HOUR_MS));
      const body = rows.map((r) => JSON.stringify(r)).join("\n");
      await this.deps.objects.put(bucket, key, body ? `${body}\n` : "", "application/x-ndjson");
      this.deps.logger.info({ key, count: rows.length }, "監査ログを書き出しました");
    }
  }
}
