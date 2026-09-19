import "server-only";
import type { MeDto } from "@agent-studio/contracts";
import { ApiRepository } from "./base";

export class MeRepository extends ApiRepository {
  get(): Promise<MeDto> {
    return this.api.get<MeDto>("/me");
  }
}
