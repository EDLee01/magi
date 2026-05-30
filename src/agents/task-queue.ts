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
  const writeFiles = (input.writeFiles ?? []).map((filePath) => {
    const resolved = resolveWorkspacePath(input.cwd, filePath);
    const existing = store.getWriteClaimByFile(resolved.relativePath);
    if (existing) {
      throw new MagiUsageError(
        `Write conflict for ${resolved.relativePath}: already claimed by ${existing.taskId}`
      );
    }
    return resolved.relativePath;
  });
  const taskId = store.createAgentTask({
    role: input.role,
    prompt: input.prompt,
    cwd: input.cwd,
    sessionId: input.sessionId,
    metadata: { writeFiles }
  });
  for (const filePath of writeFiles) {
    store.claimWriteFile({ taskId, filePath, ownerRole: input.role });
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

export function completeAgentTask(
  store: SessionStore,
  taskId: string,
  result: string
): AgentTaskRecord {
  const task = mustGetTask(store, taskId);
  store.updateAgentTask({ id: taskId, status: "completed", result, metadata: task.metadata });
  return mustGetTask(store, taskId);
}

export function cancelAgentTask(store: SessionStore, taskId: string): AgentTaskRecord {
  const task = mustGetTask(store, taskId);
  store.updateAgentTask({
    id: taskId,
    status: "cancelled",
    result: task.result,
    metadata: task.metadata
  });
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
