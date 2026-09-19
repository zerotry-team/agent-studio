import "server-only";
import type { RunDto } from "@agent-studio/contracts";
import { RunRepository } from "@/lib/repositories";

export class CancelRunService {
  constructor(private readonly runs = new RunRepository()) {}

  invoke(runId: string): Promise<RunDto> {
    return this.runs.cancel(runId);
  }
}
