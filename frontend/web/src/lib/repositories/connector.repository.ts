import "server-only";
import type { ConnectorDto, CreateConnectorInput , DiscoverMcpToolsInput, DiscoverMcpToolsResultDto, UpdateConnectorInput } from "@agent-studio/contracts";
import { ApiRepository } from "./base";

export class ConnectorRepository extends ApiRepository {
  list(): Promise<ConnectorDto[]> {
    return this.api.get<ConnectorDto[]>("/connectors");
  }

  create(input: CreateConnectorInput): Promise<ConnectorDto> {
    return this.api.post<ConnectorDto>("/connectors", input);
  }

  update(id: string, input: UpdateConnectorInput): Promise<ConnectorDto> {
    return this.api.patch<ConnectorDto>(`/connectors/${id}`, input);
  }

  discoverMcpTools(input: DiscoverMcpToolsInput): Promise<DiscoverMcpToolsResultDto> {
    return this.api.post<DiscoverMcpToolsResultDto>("/connectors/discover", input);
  }
}
