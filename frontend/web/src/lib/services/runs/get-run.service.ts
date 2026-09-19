import "server-only";
import type { RunDto } from "@agent-studio/contracts";
import { RunRepository } from "@/lib/repositories";

export class GetRunService {
  constructor(private readonly runs = new RunRepository()) {}

  invoke(id: string): Promise<RunDto> {
    return this.runs.get(id);
  }
}
