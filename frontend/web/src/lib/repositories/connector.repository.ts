import "server-only";
import type {
  ConnectionDto,
  ConnectorDto,
  ConnectorOAuthAppDto,
  CreateConnectorInput,
  DiscoverMcpToolsInput,
  DiscoverMcpToolsResultDto,
  SetConnectorOAuthAppInput,
  UpdateConnectorInput,
} from "@agent-studio/contracts";
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

  exchangeQiitaOAuth(id: string, code: string): Promise<ConnectionDto> {
    return this.api.post<ConnectionDto>(`/connectors/${encodeURIComponent(id)}/qiita-oauth/exchange`, { code });
  }

  getOAuthApp(id: string): Promise<ConnectorOAuthAppDto> {
    return this.api.get<ConnectorOAuthAppDto>(`/connectors/${encodeURIComponent(id)}/oauth-app`);
  }

  setOAuthApp(id: string, input: SetConnectorOAuthAppInput): Promise<ConnectorOAuthAppDto> {
    return this.api.put<ConnectorOAuthAppDto>(`/connectors/${encodeURIComponent(id)}/oauth-app`, input);
  }
}
