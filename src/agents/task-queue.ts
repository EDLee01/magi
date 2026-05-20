import { resolveWorkspacePath } from "../tools/workspace.js";
import { MagiUsageError } from "../errors.js";
import { AgentRole, AgentTaskRecord, SessionStore } from "../session-store.js";
import { getAgentRoleSpec } from "./roles.js";

export interface SpawnAgentTaskInput {
  role: AgentRole;
  prompt: string;
  cwd: string;
  sessionId?: string;
  writeFiles?: string[];
}

export function spawnAgentTask(store: SessionStore, input: SpawnAgentTaskInput): AgentTaskRecord {
  const spec = getAgentRoleSpec(input.role);
  if (!spec.canWrite && input.writeFiles && input.writeFiles.length > 0) {
    throw new MagiUsageError(`${spec.label} tasks cannot claim write files`);
  }
  const taskId = store.createAgentTask({
    role: input.role,
    prompt: input.prompt,
    cwd: input.cwd,
    sessionId: input.sessionId,
    metadata: { writeFiles: input.writeFiles ?? [] }
  });
  for (const filePath of input.writeFiles ?? []) {
    const resolved = resolveWorkspacePath(input.cwd, filePath);
    store.claimWriteFile({ taskId, filePath: resolved.relativePath, ownerRole: input.role });
  }
  return store.getAgentTask(taskId)!;
}

export function startAgentTask(store: SessionStore, taskId: string): AgentTaskRecord {
  const task = mustGetTask(store, taskId);
  if (task.status === "cancelled") {
    throw new Error(`Cannot start cancelled task ${taskId}`);
  }
  store.updateAgentTask({ id: taskId, status: "running", metadata: task.metadata });
  return mustGetTask(store, taskId);
}

export function completeAgentTask(store: SessionStore, taskId: string, result: string): AgentTaskRecord {
  const task = mustGetTask(store, taskId);
  store.updateAgentTask({ id: taskId, status: "completed", result, metadata: task.metadata });
  return mustGetTask(store, taskId);
}

export function cancelAgentTask(store: SessionStore, taskId: string): AgentTaskRecord {
  const task = mustGetTask(store, taskId);
  store.updateAgentTask({ id: taskId, status: "cancelled", result: task.result, metadata: task.metadata });
  return mustGetTask(store, taskId);
}

export function waitAgentTask(store: SessionStore, taskId: string): AgentTaskRecord {
  return mustGetTask(store, taskId);
}

function mustGetTask(store: SessionStore, taskId: string): AgentTaskRecord {
  const task = store.getAgentTask(taskId);
  if (!task) {
    throw new MagiUsageError(`Agent task not found: ${taskId}`);
  }
  return task;
}
