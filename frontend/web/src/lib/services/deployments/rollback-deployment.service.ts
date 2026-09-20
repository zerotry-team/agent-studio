import { DeploymentRepository } from "@/lib/repositories";

export class RollbackDeploymentService {
  constructor(private readonly deployments = new DeploymentRepository()) {}
  invoke(id: string) {
    return this.deployments.rollback(id);
  }
}
