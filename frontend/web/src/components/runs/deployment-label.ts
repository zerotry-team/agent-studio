import type { DeploymentDto } from "@agent-studio/contracts";
import { STAGE_LABELS } from "@/lib/utils/labels";

/** デプロイの表示名（例: 価格変更エージェント v3・OpenAIの環境・本番） */
export function deploymentLabel(deployment: DeploymentDto): string {
  return `${deployment.agent.name} v${deployment.agent_version}・${deployment.runtime_profile.name}・${STAGE_LABELS[deployment.stage]}`;
}
