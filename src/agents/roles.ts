import { AgentRole } from "../session-store.js";

export interface AgentRoleSpec {
  role: AgentRole;
  label: string;
  purpose: string;
  canWrite: boolean;
}

export const AGENT_ROLE_SPECS: Record<AgentRole, AgentRoleSpec> = {
  explorer: {
    role: "explorer",
    label: "Explorer",
    purpose: "Inspect context, summarize findings, and avoid file writes.",
    canWrite: false
  },
  worker: {
    role: "worker",
    label: "Worker",
    purpose: "Perform a bounded implementation task with explicit write ownership.",
    canWrite: true
  }
};

export function getAgentRoleSpec(role: AgentRole): AgentRoleSpec {
  return AGENT_ROLE_SPECS[role];
}
