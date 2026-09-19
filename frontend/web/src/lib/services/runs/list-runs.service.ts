import "server-only";
import type { RunDto } from "@agent-studio/contracts";
import { RunRepository, type RunListQuery } from "@/lib/repositories";

export class ListRunsService {
  constructor(private readonly runs = new RunRepository()) {}

  invoke(query: RunListQuery = {}): Promise<RunDto[]> {
    return this.runs.list(query);
  }
}
