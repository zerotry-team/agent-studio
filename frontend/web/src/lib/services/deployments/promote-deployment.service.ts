import { DeploymentRepository } from "@/lib/repositories";

export class PromoteDeploymentService {
  constructor(private readonly deployments = new DeploymentRepository()) {}
  invoke(id: string) {
    return this.deployments.promote(id);
  }
}
