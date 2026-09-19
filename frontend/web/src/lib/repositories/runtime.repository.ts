import "server-only";
import type { BootstrapTokenDto, CreateRuntimeInput, RuntimeDto } from "@agent-studio/contracts";
import { ApiRepository } from "./base";

export class RuntimeRepository extends ApiRepository {
  list(): Promise<RuntimeDto[]> {
    return this.api.get<RuntimeDto[]>("/runtimes");
  }

  get(id: string): Promise<RuntimeDto> {
    return this.api.get<RuntimeDto>(`/runtimes/${encodeURIComponent(id)}`);
  }

  create(input: CreateRuntimeInput): Promise<RuntimeDto> {
    return this.api.post<RuntimeDto>("/runtimes", input);
  }

  /** 平文のトークンはこの応答でしか返らない */
  issueBootstrapToken(id: string): Promise<BootstrapTokenDto> {
    return this.api.post<BootstrapTokenDto>(`/runtimes/${encodeURIComponent(id)}/bootstrap-tokens`);
  }

  revoke(id: string): Promise<RuntimeDto> {
    return this.api.post<RuntimeDto>(`/runtimes/${encodeURIComponent(id)}/revoke`);
  }

  rotateEnvironmentKey(id: string): Promise<void> {
    return this.api.post(`/runtimes/${encodeURIComponent(id)}/rotate-environment-key`);
  }
}
