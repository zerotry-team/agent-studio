import "server-only";
import { sendRunMessageSchema } from "@agent-studio/contracts";
import { RunRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

/** 実行中のエージェントに追加の指示を送る */
export class SendRunMessageService {
  constructor(private readonly runs = new RunRepository()) {}

  invoke(runId: string, input: { input: string }): Promise<void> {
    return this.runs.sendMessage(runId, parseInput(sendRunMessageSchema, input));
  }
}
