import "server-only";
import type { ToolDto } from "@agent-studio/contracts";
import { ToolRepository } from "@/lib/repositories";

export class ListToolsService {
  constructor(private readonly tools = new ToolRepository()) {}

  invoke(): Promise<ToolDto[]> {
    return this.tools.list();
  }
}
