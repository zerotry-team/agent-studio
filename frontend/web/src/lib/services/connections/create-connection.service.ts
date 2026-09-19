import "server-only";
import { createConnectionSchema, type ConnectionDto, type CreateConnectionInput } from "@agent-studio/contracts";
import { ConnectionRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

export class CreateConnectionService {
  constructor(private readonly connections = new ConnectionRepository()) {}

  invoke(input: CreateConnectionInput): Promise<ConnectionDto> {
    const payload = parseInput(createConnectionSchema, {
      ...input,
      description: input.description?.trim() || undefined,
      header_name: input.scope === "studio" ? input.header_name?.trim() || undefined : undefined,
      runtime_id: input.scope === "runtime" ? input.runtime_id || undefined : undefined,
      runtime_secret_name: input.scope === "runtime" ? input.runtime_secret_name?.trim() || undefined : undefined,
    });
    return this.connections.create(payload);
  }
}
