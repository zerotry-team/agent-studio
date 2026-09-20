import "server-only";
import type { ConnectionDto, CreateConnectionInput, SetConnectionSecretInput } from "@agent-studio/contracts";
import { ApiRepository } from "./base";

export class ConnectionRepository extends ApiRepository {
  list(): Promise<ConnectionDto[]> {
    return this.api.get<ConnectionDto[]>("/connections");
  }

  create(input: CreateConnectionInput): Promise<ConnectionDto> {
    return this.api.post<ConnectionDto>("/connections", input);
  }

  /** 書き込み専用。値を読み出す API はない */
  setSecret(id: string, input: SetConnectionSecretInput): Promise<void> {
    return this.api.put(`/connections/${encodeURIComponent(id)}/secret`, input);
  }

  validate(id: string): Promise<ConnectionDto> {
    return this.api.post<ConnectionDto>(`/connections/${encodeURIComponent(id)}/validate`, {});
  }

  revoke(id: string): Promise<ConnectionDto> {
    return this.api.post<ConnectionDto>(`/connections/${encodeURIComponent(id)}/revoke`, {});
  }

  remove(id: string): Promise<void> {
    return this.api.delete(`/connections/${encodeURIComponent(id)}`);
  }
}
