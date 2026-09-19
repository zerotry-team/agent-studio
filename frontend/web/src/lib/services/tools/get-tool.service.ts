import "server-only";
import type { ToolDto } from "@agent-studio/contracts";
import { ToolRepository } from "@/lib/repositories";

/** ツールとバージョンの一覧を取得する */
export class GetToolService {
  constructor(private readonly tools = new ToolRepository()) {}

  invoke(id: string): Promise<ToolDto> {
    return this.tools.get(id);
  }
}
