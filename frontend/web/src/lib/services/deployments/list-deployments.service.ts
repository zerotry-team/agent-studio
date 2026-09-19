import "server-only";
import type { DeploymentDto } from "@agent-studio/contracts";
import { DeploymentRepository } from "@/lib/repositories";

export class ListDeploymentsService {
  constructor(private readonly deployments = new DeploymentRepository()) {}

  invoke(query: { agent_id?: string } = {}): Promise<DeploymentDto[]> {
    return this.deployments.list(query);
  }
}
