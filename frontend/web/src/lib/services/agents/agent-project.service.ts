import type { LinkAgentConnectionInput, SetAgentEnvironmentInput , SetBrowserAccessInput } from "@agent-studio/contracts";
import { AgentRepository } from "@/lib/repositories";

export class CreateAgentProjectService {
  constructor(private readonly agents = new AgentRepository()) {}
  invoke(description: string) {
    return this.agents.createProject({ description });
  }
}

export class GetAgentProjectService {
  constructor(private readonly agents = new AgentRepository()) {}
  invoke(id: string) {
    return this.agents.getProject(id);
  }
}

/** ブラウザで接続してよい範囲を保存する */
export class SetBrowserAccessService {
  constructor(private readonly agents = new AgentRepository()) {}
  invoke(id: string, input: SetBrowserAccessInput) {
    return this.agents.setBrowserAccess(id, input);
  }
}

export class LinkAgentConnectionService {
  constructor(private readonly agents = new AgentRepository()) {}
  invoke(id: string, input: LinkAgentConnectionInput) {
    return this.agents.linkConnection(id, input);
  }
}

export class SetAgentEnvironmentService {
  constructor(private readonly agents = new AgentRepository()) {}
  invoke(id: string, input: SetAgentEnvironmentInput) {
    return this.agents.setEnvironment(id, input);
  }
}

export class CreatePreviewService {
  constructor(private readonly agents = new AgentRepository()) {}
  invoke(id: string) {
    return this.agents.createPreview(id);
  }
}
