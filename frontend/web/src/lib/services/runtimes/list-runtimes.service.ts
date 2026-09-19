import "server-only";
import type { RuntimeDto } from "@agent-studio/contracts";
import { RuntimeRepository } from "@/lib/repositories";

export class ListRuntimesService {
  constructor(private readonly runtimes = new RuntimeRepository()) {}

  invoke(): Promise<RuntimeDto[]> {
    return this.runtimes.list();
  }
}
