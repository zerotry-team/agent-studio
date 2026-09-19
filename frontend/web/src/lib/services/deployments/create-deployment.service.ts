import "server-only";
import { createDeploymentSchema, type CreateDeploymentInput, type DeploymentDto } from "@agent-studio/contracts";
import { DeploymentRepository } from "@/lib/repositories";
import { parseInput } from "@/lib/utils/validation";

export class CreateDeploymentService {
  constructor(private readonly deployments = new DeploymentRepository()) {}

  invoke(input: CreateDeploymentInput): Promise<DeploymentDto> {
    return this.deployments.create(parseInput(createDeploymentSchema, input));
  }
}
