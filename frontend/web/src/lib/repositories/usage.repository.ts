import "server-only";
import type { UsageDto } from "@agent-studio/contracts";
import { ApiRepository } from "./base";

export class UsageRepository extends ApiRepository {
  /** month: YYYY-MM */
  get(month?: string): Promise<UsageDto> {
    return this.api.get<UsageDto>("/usage", { month });
  }
}
