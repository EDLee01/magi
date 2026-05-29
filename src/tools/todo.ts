import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { HookDefinition } from "../config.js";
import { triggerHook } from "../hooks/trigger.js";
import { atomicWrite } from "../fs-utils.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  priority?: "low" | "medium" | "high";
}

export interface TodoSessionState {
  sessionId: string;
  todos: TodoItem[];
  updatedAt: string;
}

export interface TodoStoreData {
  version: 1;
  sessions: Record<string, TodoSessionState>;
}

export interface TodoWriteResult {
  previousTodos: TodoItem[];
  todos: TodoItem[];
  stateFile: string;
  updatedAt: string;
}

export const TodoStatusValues: TodoStatus[] = ["pending", "in_progress", "completed"];

export const TodoWriteInputSchema = {
  type: "object",
  properties: {
    todos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          content: { type: "string" },
          status: { type: "string", enum: TodoStatusValues },
          priority: { type: "string", enum: ["low", "medium", "high"] }
        },
        required: ["id", "content", "status"],
        additionalProperties: false
      }
    }
  },
  required: ["todos"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function todoStorePathFromRoot(stateRoot: string): string {
  return path.join(stateRoot, "todos.json");
}

export async function replaceTodoList(input: {
  stateRoot: string;
  sessionId: string;
  todos: TodoItem[];
  now?: Date;
  hooks?: import("../config.js").HookDefinition[];
  cwd?: string;
}): Promise<TodoWriteResult> {
  const stateFile = todoStorePathFromRoot(input.stateRoot);
  const store = loadTodoStore(stateFile);
  const previousTodos = store.sessions[input.sessionId]?.todos ?? [];
  const updatedAt = (input.now ?? new Date()).toISOString();
  store.sessions[input.sessionId] = {
    sessionId: input.sessionId,
    todos: input.todos,
    updatedAt
  };
  saveTodoStore(stateFile, store);

  if (input.hooks) {
    const { triggerHook } = await import("../hooks/trigger.js");
    const previousIds = new Set(previousTodos.map((t) => t.id));
    const currentIds = new Set(input.todos.map((t) => t.id));

    for (const todo of input.todos) {
      if (!previousIds.has(todo.id)) {
        void triggerHook({
          event: "task_created",
          hooks: input.hooks,
          context: {
            cwd: input.cwd ?? process.cwd(),
            taskId: todo.id,
            taskSubject: todo.content,
            taskDescription: `Priority: ${todo.priority ?? "normal"}`
          }
        });
      }

      const prevTodo = previousTodos.find((t) => t.id === todo.id);
      if (prevTodo && prevTodo.status !== "completed" && todo.status === "completed") {
        void triggerHook({
          event: "task_completed",
          hooks: input.hooks,
          context: {
            cwd: input.cwd ?? process.cwd(),
            taskId: todo.id,
            taskSubject: todo.content
          }
        });
      }
    }
  }

  return {
    previousTodos,
    todos: input.todos,
    stateFile,
    updatedAt
  };
}

export function parseTodoWriteInput(input: Record<string, unknown>): TodoItem[] {
  assertAllowedKeys(input, ["todos"], "TodoWrite input");
  return readTodoList(input.todos);
}

export function loadTodoStore(filePath: string): TodoStoreData {
  if (!existsSync(filePath)) {
    return { version: 1, sessions: {} };
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.sessions)) {
    throw new Error(`Invalid todo store: ${filePath}`);
  }
  const sessions: Record<string, TodoSessionState> = {};
  for (const [sessionId, value] of Object.entries(parsed.sessions)) {
    sessions[sessionId] = readTodoSessionState(sessionId, value);
  }
  return { version: 1, sessions };
}

export function saveTodoStore(filePath: string, store: TodoStoreData): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWrite(filePath, `${JSON.stringify(store, null, 2)}\n`);
}

export function readTodoList(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) {
    throw new Error("Tool input todos must be an array");
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const todo = readTodoItem(item, `todos[${index}]`);
    if (seen.has(todo.id)) {
      throw new Error(`Todo id must be unique: ${todo.id}`);
    }
    seen.add(todo.id);
    return todo;
  });
}

export function formatTodoWriteResult(result: TodoWriteResult): string {
  const added = result.todos.filter(
    (todo) => !result.previousTodos.some((previous) => previous.id === todo.id)
  ).length;
  const removed = result.previousTodos.filter(
    (previous) => !result.todos.some((todo) => todo.id === previous.id)
  ).length;
  const changed = result.todos.filter((todo) => {
    const previous = result.previousTodos.find((item) => item.id === todo.id);
    return previous && JSON.stringify(previous) !== JSON.stringify(todo);
  }).length;
  const counts = TodoStatusValues.map(
    (status) => `${status}: ${result.todos.filter((todo) => todo.status === status).length}`
  );
  return [
    `Todo list replaced (${result.todos.length} items)`,
    `changes: +${added} ~${changed} -${removed}`,
    `status: ${counts.join(", ")}`,
    `updatedAt: ${result.updatedAt}`,
    `stateFile: ${result.stateFile}`,
    "",
    formatTodoList(result.todos)
  ]
    .join("\n")
    .trimEnd();
}

export function formatTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) {
    return "No todos";
  }
  return todos
    .map((todo, index) => {
      const priority = todo.priority ? ` priority=${todo.priority}` : "";
      return `${index + 1}. [${todo.status}] ${todo.id}${priority} - ${todo.content}`;
    })
    .join("\n");
}

function readTodoSessionState(sessionId: string, value: unknown): TodoSessionState {
  if (!isRecord(value)) {
    throw new Error(`Invalid todo session state for ${sessionId}`);
  }
  const storedSessionId = typeof value.sessionId === "string" ? value.sessionId : sessionId;
  if (storedSessionId !== sessionId) {
    throw new Error(`Todo session key mismatch: ${sessionId}`);
  }
  if (typeof value.updatedAt !== "string" || !value.updatedAt.trim()) {
    throw new Error(`Todo session ${sessionId} updatedAt must be a non-empty string`);
  }
  return {
    sessionId,
    todos: readTodoList(value.todos),
    updatedAt: value.updatedAt
  };
}

function readTodoItem(value: unknown, label: string): TodoItem {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  assertAllowedKeys(value, ["id", "content", "status", "priority"], label);
  const id = readNonEmptyString(value.id, `${label}.id`);
  const content = readNonEmptyString(value.content, `${label}.content`);
  if (!TodoStatusValues.includes(value.status as TodoStatus)) {
    throw new Error(`${label}.status must be pending, in_progress, or completed`);
  }
  const todo: TodoItem = {
    id,
    content,
    status: value.status as TodoStatus
  };
  if (value.priority !== undefined) {
    if (value.priority !== "low" && value.priority !== "medium" && value.priority !== "high") {
      throw new Error(`${label}.priority must be low, medium, or high`);
    }
    todo.priority = value.priority;
  }
  return todo;
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown field: ${unknown[0]}`);
  }
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
