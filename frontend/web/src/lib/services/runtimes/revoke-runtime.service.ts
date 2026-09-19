import "server-only";
import type { RuntimeDto } from "@agent-studio/contracts";
import { RuntimeRepository } from "@/lib/repositories";

/** Runtime を失効させる（オーナーのみ。元に戻せない） */
export class RevokeRuntimeService {
  constructor(private readonly runtimes = new RuntimeRepository()) {}

  invoke(runtimeId: string): Promise<RuntimeDto> {
    return this.runtimes.revoke(runtimeId);
  }
}
