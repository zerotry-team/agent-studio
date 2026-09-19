import "server-only";
import { RunRepository, type RunEventsResponse } from "@/lib/repositories";

/** 実行の状態と、after_seq より後のイベントを取得する（画面側で 2 秒ごとに呼ぶ） */
export class GetRunEventsService {
  constructor(private readonly runs = new RunRepository()) {}

  async invoke(runId: string, afterSeq = 0): Promise<RunEventsResponse> {
    const seq = Number.isInteger(afterSeq) && afterSeq >= 0 ? afterSeq : 0;
    const res = await this.runs.events(runId, seq);
    return { run: res.run, events: [...res.events].sort((a, b) => a.seq - b.seq) };
  }
}
