import "server-only";
import { RuntimeRepository } from "@/lib/repositories";

/** 環境キーの入れ替えを依頼する（非同期で行われる） */
export class RotateEnvironmentKeyService {
  constructor(private readonly runtimes = new RuntimeRepository()) {}

  invoke(runtimeId: string): Promise<void> {
    return this.runtimes.rotateEnvironmentKey(runtimeId);
  }
}
