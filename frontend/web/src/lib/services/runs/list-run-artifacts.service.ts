import "server-only";
import type { RunArtifactDto } from "@agent-studio/contracts";
import { RunRepository } from "@/lib/repositories";

/** 実行の成果物（ダウンロード用の URL は5分だけ有効） */
export class ListRunArtifactsService {
  constructor(private readonly runs = new RunRepository()) {}

  invoke(id: string): Promise<RunArtifactDto[]> {
    return this.runs.artifacts(id);
  }
}
