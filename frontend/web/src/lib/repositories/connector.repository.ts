import "server-only";
import type {
  ConnectionDto,
  ConnectorDto,
  ConnectorOAuthAppDto,
  ConnectorOAuthExchangeInput,
  ConnectorOAuthStartDto,
  ConnectorOAuthStartInput,
  CreateConnectorInput,
  DiscoverMcpToolsInput,
  DiscoverMcpToolsResultDto,
  ProviderCatalogEntryDto,
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

  /** Provider Catalog（有名サービスの一覧と、この組織での登録状況） */
  listCatalog(): Promise<ProviderCatalogEntryDto[]> {
    return this.api.get<ProviderCatalogEntryDto[]>("/connectors/catalog");
  }

  /** カタログから連携サービスを用意する（登録済みなら再利用） */
  ensureCatalog(key: string): Promise<ConnectorDto> {
    return this.api.post<ConnectorDto>(`/connectors/catalog/${encodeURIComponent(key)}/ensure`, {});
  }

  startOAuth(id: string, input: ConnectorOAuthStartInput): Promise<ConnectorOAuthStartDto> {
    return this.api.post<ConnectorOAuthStartDto>(`/connectors/${encodeURIComponent(id)}/oauth/start`, input);
  }

  exchangeOAuth(id: string, input: ConnectorOAuthExchangeInput): Promise<ConnectionDto> {
    return this.api.post<ConnectionDto>(`/connectors/${encodeURIComponent(id)}/oauth/exchange`, input);
  }

  getOAuthApp(id: string): Promise<ConnectorOAuthAppDto> {
    return this.api.get<ConnectorOAuthAppDto>(`/connectors/${encodeURIComponent(id)}/oauth-app`);
  }

  setOAuthApp(id: string, input: SetConnectorOAuthAppInput): Promise<ConnectorOAuthAppDto> {
    return this.api.put<ConnectorOAuthAppDto>(`/connectors/${encodeURIComponent(id)}/oauth-app`, input);
  }
}
