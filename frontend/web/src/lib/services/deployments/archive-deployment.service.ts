import "server-only";
import type { DeploymentDto } from "@agent-studio/contracts";
import { DeploymentRepository } from "@/lib/repositories";

export class ArchiveDeploymentService {
  constructor(private readonly deployments = new DeploymentRepository()) {}

  invoke(id: string): Promise<DeploymentDto> {
    return this.deployments.archive(id);
  }
}
