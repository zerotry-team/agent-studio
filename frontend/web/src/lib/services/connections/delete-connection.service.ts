import "server-only";
import { ConnectionRepository } from "@/lib/repositories";

export class DeleteConnectionService {
  constructor(private readonly connections = new ConnectionRepository()) {}

  invoke(id: string): Promise<void> {
    return this.connections.remove(id);
  }
}
