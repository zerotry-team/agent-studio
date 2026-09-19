import type { ToolAuditEvent } from "@agent-studio/contracts";
import type { Logger } from "./logger.js";
import { errorInfo } from "./logger.js";

export interface AuditBufferOptions {
  batchSize?: number;
  /** これを超えたら古いものから捨てる（Agent Studio に長時間つながらないときの上限） */
  maxBuffered?: number;
  /** 再送しても成功しない失敗（形式エラーなど）。そのバッチは捨てる */
  isPermanentFailure?: (err: unknown) => boolean;
}

/** Tool Gateway から受け取った監査イベントをまとめて Agent Studio に送る */
export class AuditBuffer {
  private queue: ToolAuditEvent[] = [];
  private flushing: Promise<void> | undefined;
  private readonly batchSize: number;
  private readonly maxBuffered: number;
  private readonly isPermanentFailure: (err: unknown) => boolean;

  constructor(
    private readonly send: (events: ToolAuditEvent[]) => Promise<void>,
    private readonly logger: Logger,
    opts: AuditBufferOptions = {},
  ) {
    this.batchSize = Math.min(opts.batchSize ?? 500, 500);
    this.maxBuffered = opts.maxBuffered ?? 20_000;
    this.isPermanentFailure = opts.isPermanentFailure ?? (() => false);
  }

  get size(): number {
    return this.queue.length;
  }

  push(events: ToolAuditEvent[]): void {
    this.queue.push(...events);
    const overflow = this.queue.length - this.maxBuffered;
    if (overflow > 0) {
      this.queue.splice(0, overflow);
      this.logger.warn({ dropped: overflow }, "監査イベントが溜まりすぎたため、古いものを捨てました");
    }
  }

  /** 送れるだけ送る。失敗したら残りは次回に回す */
  flush(): Promise<void> {
    this.flushing ??= this.doFlush().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    while (this.queue.length > 0) {
      // 送信中に push で溢れても影響しないよう、先に取り出す
      const batch = this.queue.splice(0, this.batchSize);
      try {
        await this.send(batch);
      } catch (err) {
        if (this.isPermanentFailure(err)) {
          this.logger.error({ err: errorInfo(err), dropped: batch.length }, "Agent Studio が監査イベントを受け付けなかったため、捨てました");
          continue;
        }
        this.queue.unshift(...batch);
        this.logger.warn({ err: errorInfo(err), pending: this.queue.length }, "監査イベントを送れませんでした。後で再送します");
        return;
      }
    }
  }
}
