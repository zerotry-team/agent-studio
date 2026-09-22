import "server-only";
import type { RuntimeDto } from "@agent-studio/contracts";
import { RuntimeRepository } from "@/lib/repositories";

export class RetryManagedRuntimeProvisioningService {
  constructor(private readonly runtimes = new RuntimeRepository()) {}

  invoke(runtimeId: string): Promise<RuntimeDto> {
    return this.runtimes.retryManagedProvisioning(runtimeId);
  }
}
