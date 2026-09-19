import "server-only";
import type { RuntimeDto } from "@agent-studio/contracts";
import { RuntimeRepository } from "@/lib/repositories";

export class GetRuntimeService {
  constructor(private readonly runtimes = new RuntimeRepository()) {}

  invoke(id: string): Promise<RuntimeDto> {
    return this.runtimes.get(id);
  }
}
