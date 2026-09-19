import "server-only";
import type { CreateRunInput, RunArtifactDto, RunDto, RunEventDto } from "@agent-studio/contracts";
import { ApiRepository, type ListQuery } from "./base";

export interface RunListQuery extends ListQuery {
  deployment_id?: string;
}

export interface RunEventsResponse {
  run: RunDto;
  events: RunEventDto[];
}

export class RunRepository extends ApiRepository {
  list(query: RunListQuery = {}): Promise<RunDto[]> {
    return this.api.get<RunDto[]>("/runs", { ...query });
  }

  get(id: string): Promise<RunDto> {
    return this.api.get<RunDto>(`/runs/${encodeURIComponent(id)}`);
  }

  events(id: string, afterSeq: number): Promise<RunEventsResponse> {
    return this.api.get<RunEventsResponse>(`/runs/${encodeURIComponent(id)}/events`, { after_seq: afterSeq });
  }

  artifacts(id: string): Promise<RunArtifactDto[]> {
    return this.api.get<RunArtifactDto[]>(`/runs/${encodeURIComponent(id)}/artifacts`);
  }

  create(input: CreateRunInput): Promise<RunDto> {
    return this.api.post<RunDto>("/runs", input);
  }

  sendMessage(id: string, input: { input: string }): Promise<void> {
    return this.api.post(`/runs/${encodeURIComponent(id)}/messages`, input);
  }

  cancel(id: string): Promise<RunDto> {
    return this.api.post<RunDto>(`/runs/${encodeURIComponent(id)}/cancel`);
  }
}
