import "server-only";
import type { ToolDto, ToolVersionDto, ToolVersionSpec } from "@agent-studio/contracts";
import { ApiRepository } from "./base";

export class ToolRepository extends ApiRepository {
  list(): Promise<ToolDto[]> {
    return this.api.get<ToolDto[]>("/tools");
  }

  get(id: string): Promise<ToolDto> {
    return this.api.get<ToolDto>(`/tools/${encodeURIComponent(id)}`);
  }

  create(input: { name: string; display_name: string; spec: ToolVersionSpec }): Promise<ToolDto> {
    return this.api.post<ToolDto>("/tools", input);
  }

  createVersion(id: string, input: { spec: ToolVersionSpec }): Promise<ToolVersionDto> {
    return this.api.post<ToolVersionDto>(`/tools/${encodeURIComponent(id)}/versions`, input);
  }
}
