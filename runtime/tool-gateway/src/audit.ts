import type { ToolAuditEvent } from "@agent-studio/contracts";
import type { ControllerApi } from "./controller-client.js";
import type { Logger } from "./logger.js";
import { errorMessage } from "./logger.js";

export interface AuditSink {
  /** 待たない（ツールの結果を監査の送信で遅らせない） */
  record(event: Omit<ToolAuditEvent, "at"> & { at?: string }): void;
}

/**
 * 監査イベントを CloudWatch Logs（標準出力）に書き、Controller 経由で Agent Studio に送る。
 * 引数そのものは含めない（args_hash だけ）。
 */
export class ControllerAuditSink implements AuditSink {
  private queue: ToolAuditEvent[] = [];
  private flushing = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly controller: Pick<ControllerApi, "sendAudit">,
    private readonly logger: Logger,
    private readonly opts: { flushIntervalMs?: number; maxQueued?: number } = {},
  ) {}

  start(): void {
    this.timer ??= setInterval(() => void this.flush(), this.opts.flushIntervalMs ?? 1_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  record(input: Omit<ToolAuditEvent, "at"> & { at?: string }): void {
    const event: ToolAuditEvent = {
      ...input,
      ...(input.detail ? { detail: input.detail.slice(0, 1000) } : {}),
      at: input.at ?? new Date().toISOString(),
    };
    this.logger.info({ audit: event }, "tool_audit");
    this.queue.push(event);
    const max = this.opts.maxQueued ?? 5_000;
    if (this.queue.length > max) this.queue.splice(0, this.queue.length - max);
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, 500);
        try {
          await this.controller.sendAudit(batch);
        } catch (err) {
          this.queue.unshift(...batch);
          this.logger.warn({ err: errorMessage(err), pending: this.queue.length }, "監査イベントを Controller に送れませんでした");
          return;
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
