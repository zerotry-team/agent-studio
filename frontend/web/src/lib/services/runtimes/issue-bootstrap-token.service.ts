import "server-only";
import type { BootstrapTokenDto } from "@agent-studio/contracts";
import { RuntimeRepository } from "@/lib/repositories";

/** 登録用トークンを発行する。平文はこの応答でしか受け取れない */
export class IssueBootstrapTokenService {
  constructor(private readonly runtimes = new RuntimeRepository()) {}

  invoke(runtimeId: string): Promise<BootstrapTokenDto> {
    return this.runtimes.issueBootstrapToken(runtimeId);
  }
}
