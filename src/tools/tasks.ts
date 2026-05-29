/**
 * Incremental task management tools: TaskCreate, TaskUpdate, TaskList.
 *
 * These operate on the same underlying todo store as TodoWrite but provide
 * incremental operations that match the real Magi task management UX.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  TodoItem,
  TodoStatus,
  TodoStatusValues,
  loadTodoStore,
  saveTodoStore,
  todoStorePathFromRoot
} from "./todo.js";

export interface TaskCreateInput {
  subject: string;
  description?: string;
  priority?: "low" | "medium" | "high";
  activeForm?: string;
}

export interface TaskUpdateInput {
  taskId: string;
  status?: TodoStatus | "deleted";
  subject?: string;
  description?: string;
  priority?: "low" | "medium" | "high";
  activeForm?: string;
}

export interface TaskListResult {
  tasks: TaskView[];
}

export interface TaskView {
  id: string;
  subject: string;
  status: TodoStatus;
  priority?: "low" | "medium" | "high";
  description?: string;
  activeForm?: string;
}

// --- Input Schemas ---

export const TaskCreateInputSchema = {
  type: "object",
  properties: {
    subject: { type: "string", description: "Brief title for the task" },
    description: { type: "string", description: "What needs to be done" },
    priority: { type: "string", enum: ["low", "medium", "high"] },
    activeForm: { type: "string", description: "Present continuous form shown when in_progress" }
  },
  required: ["subject"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export const TaskUpdateInputSchema = {
  type: "object",
  properties: {
    taskId: { type: "string", description: "The ID of the task to update" },
    status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] },
    subject: { type: "string" },
    description: { type: "string" },
    priority: { type: "string", enum: ["low", "medium", "high"] },
    activeForm: { type: "string" }
  },
  required: ["taskId"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export const TaskListInputSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false
} satisfies Record<string, unknown>;

export const TaskGetInputSchema = {
  type: "object",
  properties: {
    taskId: { type: "string", description: "The ID of the task to retrieve" }
  },
  required: ["taskId"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export const TaskStopInputSchema = {
  type: "object",
  properties: {
    taskId: { type: "string", description: "The ID of the background task to stop" }
  },
  required: ["taskId"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export const TaskOutputInputSchema = {
  type: "object",
  properties: {
    taskId: { type: "string", description: "The ID of the task to get output from" },
    block: { type: "boolean", description: "Whether to wait for completion (default true)" }
  },
  required: ["taskId"],
  additionalProperties: false
} satisfies Record<string, unknown>;

// --- Parsing ---

export function parseTaskCreateInput(input: Record<string, unknown>): TaskCreateInput {
  const subject = input.subject;
  if (typeof subject !== "string" || !subject.trim()) {
    throw new Error("TaskCreate requires a non-empty subject");
  }
  return {
    subject: subject.trim(),
    description:
      typeof input.description === "string" ? input.description.trim() || undefined : undefined,
    priority: readPriority(input.priority),
    activeForm:
      typeof input.activeForm === "string" ? input.activeForm.trim() || undefined : undefined
  };
}

export function parseTaskUpdateInput(input: Record<string, unknown>): TaskUpdateInput {
  const taskId = input.taskId;
  if (typeof taskId !== "string" || !taskId.trim()) {
    throw new Error("TaskUpdate requires a non-empty taskId");
  }
  const status = input.status;
  let parsedStatus: TodoStatus | "deleted" | undefined;
  if (status !== undefined) {
    if (
      status !== "pending" &&
      status !== "in_progress" &&
      status !== "completed" &&
      status !== "deleted"
    ) {
      throw new Error("TaskUpdate status must be pending, in_progress, completed, or deleted");
    }
    parsedStatus = status;
  }
  return {
    taskId: taskId.trim(),
    status: parsedStatus,
    subject: typeof input.subject === "string" ? input.subject.trim() || undefined : undefined,
    description:
      typeof input.description === "string" ? input.description.trim() || undefined : undefined,
    priority: readPriority(input.priority),
    activeForm:
      typeof input.activeForm === "string" ? input.activeForm.trim() || undefined : undefined
  };
}

// --- Execution ---

export function executeTaskCreate(input: {
  stateRoot: string;
  sessionId: string;
  task: TaskCreateInput;
}): { task: TaskView; allTasks: TaskView[] } {
  const stateFile = todoStorePathFromRoot(input.stateRoot);
  const store = loadTodoStore(stateFile);
  const session = store.sessions[input.sessionId] ?? {
    sessionId: input.sessionId,
    todos: [],
    updatedAt: new Date().toISOString()
  };

  const id = String(session.todos.length + 1);
  const newTodo: TodoItem = {
    id,
    content: input.task.subject,
    status: "pending",
    priority: input.task.priority
  };
  session.todos.push(newTodo);
  session.updatedAt = new Date().toISOString();
  store.sessions[input.sessionId] = session;
  saveTodoStore(stateFile, store);

  const taskView: TaskView = {
    id,
    subject: input.task.subject,
    status: "pending",
    priority: input.task.priority,
    description: input.task.description,
    activeForm: input.task.activeForm
  };
  return { task: taskView, allTasks: todosToViews(session.todos) };
}

export function executeTaskUpdate(input: {
  stateRoot: string;
  sessionId: string;
  update: TaskUpdateInput;
}): { task: TaskView | null; allTasks: TaskView[] } {
  const stateFile = todoStorePathFromRoot(input.stateRoot);
  const store = loadTodoStore(stateFile);
  const session = store.sessions[input.sessionId];
  if (!session) {
    throw new Error(`No tasks found for session ${input.sessionId}`);
  }

  const index = session.todos.findIndex((t) => t.id === input.update.taskId);
  if (index === -1) {
    throw new Error(`Task ${input.update.taskId} not found`);
  }

  if (input.update.status === "deleted") {
    session.todos.splice(index, 1);
    session.updatedAt = new Date().toISOString();
    store.sessions[input.sessionId] = session;
    saveTodoStore(stateFile, store);
    return { task: null, allTasks: todosToViews(session.todos) };
  }

  const todo = session.todos[index];
  if (input.update.subject) todo.content = input.update.subject;
  if (input.update.status) todo.status = input.update.status;
  if (input.update.priority) todo.priority = input.update.priority;
  session.updatedAt = new Date().toISOString();
  store.sessions[input.sessionId] = session;
  saveTodoStore(stateFile, store);

  return {
    task: { id: todo.id, subject: todo.content, status: todo.status, priority: todo.priority },
    allTasks: todosToViews(session.todos)
  };
}

export function executeTaskList(input: { stateRoot: string; sessionId: string }): TaskListResult {
  const stateFile = todoStorePathFromRoot(input.stateRoot);
  const store = loadTodoStore(stateFile);
  const session = store.sessions[input.sessionId];
  if (!session) {
    return { tasks: [] };
  }
  return { tasks: todosToViews(session.todos) };
}

export function executeTaskGet(input: {
  stateRoot: string;
  sessionId: string;
  taskId: string;
}): TaskView | null {
  const stateFile = todoStorePathFromRoot(input.stateRoot);
  const store = loadTodoStore(stateFile);
  const session = store.sessions[input.sessionId];
  if (!session) return null;
  const todo = session.todos.find((t) => t.id === input.taskId);
  if (!todo) return null;
  return { id: todo.id, subject: todo.content, status: todo.status, priority: todo.priority };
}

export async function executeTaskStop(input: {
  stateRoot: string;
  sessionId: string;
  taskId: string;
  store?: import("../session-store.js").SessionStore;
}): Promise<{ stopped: boolean; task: TaskView | null }> {
  // Try jobs table first
  let jobStore = input.store;
  let shouldCloseStore = false;
  if (!jobStore) {
    try {
      const dbPath = path.join(input.stateRoot, "sessions.sqlite");
      if (existsSync(dbPath)) {
        const mod = await import("../session-store.js");
        jobStore = new mod.SessionStore(dbPath);
        shouldCloseStore = true;
      }
    } catch {
      // Best effort
    }
  }
  try {
    if (jobStore) {
      const job = jobStore.getJob(input.taskId);
      if (job) {
        if (job.status === "running") {
          const meta = (job.metadata ?? {}) as Record<string, unknown>;
          jobStore.updateJobStatus({
            id: job.id,
            status: "cancelled",
            metadata: { ...meta, cancelledAt: new Date().toISOString() }
          });
          return {
            stopped: true,
            task: {
              id: job.id,
              subject: typeof meta.description === "string" ? meta.description : job.kind,
              status: "cancelled" as TodoStatus
            }
          };
        }
        const meta = (job.metadata ?? {}) as Record<string, unknown>;
        return {
          stopped: false,
          task: {
            id: job.id,
            subject: typeof meta.description === "string" ? meta.description : job.kind,
            status: job.status as TodoStatus
          }
        };
      }
    }
    // Fallback: per-session todo entries
    const stateFile = todoStorePathFromRoot(input.stateRoot);
    const store = loadTodoStore(stateFile);
    const session = store.sessions[input.sessionId];
    if (!session) return { stopped: false, task: null };
    const todo = session.todos.find((t) => t.id === input.taskId);
    if (!todo) return { stopped: false, task: null };
    if (todo.status !== "in_progress") return { stopped: false, task: todosToViews([todo])[0] };
    todo.status = "pending";
    session.updatedAt = new Date().toISOString();
    store.sessions[input.sessionId] = session;
    saveTodoStore(stateFile, store);
    return {
      stopped: true,
      task: { id: todo.id, subject: todo.content, status: todo.status, priority: todo.priority }
    };
  } finally {
    if (shouldCloseStore && jobStore) {
      jobStore.close();
    }
  }
}

export async function executeTaskOutput(input: {
  stateRoot: string;
  sessionId: string;
  taskId: string;
  store?: import("../session-store.js").SessionStore;
}): Promise<{ taskId: string; status: string; output?: string }> {
  // First try the jobs table (background sub-agent tasks)
  let jobStore = input.store;
  let shouldCloseStore = false;
  if (!jobStore) {
    try {
      const dbPath = path.join(input.stateRoot, "sessions.sqlite");
      if (existsSync(dbPath)) {
        const mod = await import("../session-store.js");
        jobStore = new mod.SessionStore(dbPath);
        shouldCloseStore = true;
      }
    } catch {
      // Best effort
    }
  }
  try {
    if (jobStore) {
      const job = jobStore.getJob(input.taskId);
      if (job) {
        const meta = (job.metadata ?? {}) as Record<string, unknown>;
        const result = typeof meta.result === "string" ? meta.result : undefined;
        const error = typeof meta.error === "string" ? meta.error : undefined;
        const description = typeof meta.description === "string" ? meta.description : undefined;
        const lines: string[] = [];
        if (description) lines.push(`Description: ${description}`);
        lines.push(`Status: ${job.status}`);
        if (result) lines.push(`\nResult:\n${result}`);
        if (error) lines.push(`\nError:\n${error}`);
        return { taskId: job.id, status: job.status, output: lines.join("\n") };
      }
    }
    // Fallback: per-session todo entries
    const stateFile = todoStorePathFromRoot(input.stateRoot);
    const store = loadTodoStore(stateFile);
    const session = store.sessions[input.sessionId];
    if (!session) return { taskId: input.taskId, status: "not_found" };
    const todo = session.todos.find((t) => t.id === input.taskId);
    if (!todo) return { taskId: input.taskId, status: "not_found" };
    return {
      taskId: todo.id,
      status: todo.status,
      output: `Task #${todo.id}: [${todo.status}] ${todo.content}`
    };
  } finally {
    if (shouldCloseStore && jobStore) {
      jobStore.close();
    }
  }
}

// --- Formatting ---

export function formatTaskCreateResult(result: { task: TaskView; allTasks: TaskView[] }): string {
  return `Task #${result.task.id} created: ${result.task.subject}\n\n${formatTaskListCompact(result.allTasks)}`;
}

export function formatTaskUpdateResult(result: {
  task: TaskView | null;
  allTasks: TaskView[];
}): string {
  if (!result.task) {
    return `Task deleted.\n\n${formatTaskListCompact(result.allTasks)}`;
  }
  return `Task #${result.task.id} updated: [${result.task.status}] ${result.task.subject}\n\n${formatTaskListCompact(result.allTasks)}`;
}

export function formatTaskListResult(result: TaskListResult): string {
  if (result.tasks.length === 0) {
    return "No tasks.";
  }
  return formatTaskListCompact(result.tasks);
}

export function formatTaskGetResult(task: TaskView | null): string {
  if (!task) return "Task not found.";
  const prio = task.priority ? `\npriority: ${task.priority}` : "";
  const desc = task.description ? `\ndescription: ${task.description}` : "";
  return `#${task.id} [${task.status}] ${task.subject}${prio}${desc}`;
}

export function formatTaskStopResult(result: { stopped: boolean; task: TaskView | null }): string {
  if (!result.task) return "Task not found.";
  if (!result.stopped)
    return `Task #${result.task.id} is not running (status: ${result.task.status}).`;
  return `Task #${result.task.id} stopped.`;
}

export function formatTaskOutputResult(result: {
  taskId: string;
  status: string;
  output?: string;
}): string {
  if (result.status === "not_found") return `Task ${result.taskId} not found.`;
  return result.output ?? `Task ${result.taskId}: ${result.status}`;
}

function formatTaskListCompact(tasks: TaskView[]): string {
  return tasks
    .map((t) => {
      const icon = t.status === "completed" ? "done" : t.status === "in_progress" ? "wip" : "todo";
      const prio = t.priority ? ` [${t.priority}]` : "";
      return `#${t.id} [${icon}]${prio} ${t.subject}`;
    })
    .join("\n");
}

// --- Helpers ---

function todosToViews(todos: TodoItem[]): TaskView[] {
  return todos.map((t) => ({
    id: t.id,
    subject: t.content,
    status: t.status,
    priority: t.priority
  }));
}

function readPriority(value: unknown): "low" | "medium" | "high" | undefined {
  if (value === undefined) return undefined;
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new Error("priority must be low, medium, or high");
}
