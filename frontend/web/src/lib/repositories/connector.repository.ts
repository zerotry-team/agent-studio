import "server-only";
import type { ConnectorDto, CreateConnectorInput } from "@agent-studio/contracts";
import { ApiRepository } from "./base";

export class ConnectorRepository extends ApiRepository {
  list(): Promise<ConnectorDto[]> {
    return this.api.get<ConnectorDto[]>("/connectors");
  }

  create(input: CreateConnectorInput): Promise<ConnectorDto> {
    return this.api.post<ConnectorDto>("/connectors", input);
  }
}
