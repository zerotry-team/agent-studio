import "server-only";
import type { ConnectionDto } from "@agent-studio/contracts";
import { ConnectionRepository } from "@/lib/repositories";

export class ListConnectionsService {
  constructor(private readonly connections = new ConnectionRepository()) {}

  invoke(): Promise<ConnectionDto[]> {
    return this.connections.list();
  }
}
