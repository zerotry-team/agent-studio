import "server-only";
import type { CreateRuntimeProfileInput, RuntimeProfileDto } from "@agent-studio/contracts";
import { ApiRepository } from "./base";

/** 実行環境の設定（API のパスは /environments） */
export class RuntimeProfileRepository extends ApiRepository {
  list(): Promise<RuntimeProfileDto[]> {
    return this.api.get<RuntimeProfileDto[]>("/environments");
  }

  create(input: CreateRuntimeProfileInput): Promise<RuntimeProfileDto> {
    return this.api.post<RuntimeProfileDto>("/environments", input);
  }

  remove(id: string): Promise<void> {
    return this.api.delete(`/environments/${encodeURIComponent(id)}`);
  }
}
