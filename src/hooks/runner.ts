import { spawn } from "node:child_process";

import { HookDefinition, HookEvent } from "../config.js";
import { createShellInvocation } from "../platform/shell.js";
import { MagiMessage } from "../providers/ir.js";

export interface HookContext {
  sessionId: string;
  cwd: string;
  jobId?: string;
  source?: "startup" | "resume" | "clear" | "compact" | "query";
  model?: string;
  provider?: string;
  permissionMode?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  toolResponse?: string;
  error?: string;
  message?: string;
  title?: string;
  notificationType?: string;
  lastAssistantMessage?: string;
  trigger?: "manual" | "auto";
  customInstructions?: string;
  compactSummary?: string;
  sourceMessageCount?: number;
  prompt?: string;
  reason?: string;
  permissionSuggestions?: string[];
  agentId?: string;
  agentType?: string;
  agentTranscriptPath?: string;
  taskId?: string;
  taskSubject?: string;
  taskDescription?: string;
  teammateName?: string;
  teamName?: string;
  mcpServerName?: string;
  mode?: string;
  url?: string;
  elicitationId?: string;
  requestedSchema?: Record<string, unknown>;
  action?: string;
  content?: unknown;
  filePath?: string;
  event?: string;
  name?: string;
  worktreePath?: string;
  memoryType?: string;
  loadReason?: string;
  oldCwd?: string;
  newCwd?: string;
  errorDetails?: string;
}

export interface HookResult {
  hook: HookDefinition;
  output: string;
  exitCode: number | null;
  blocked: boolean;
  timedOut?: boolean;
  error?: string;
  status?: number;
}

export async function executeHooks(input: {
  event: HookEvent;
  hooks: HookDefinition[];
  context: HookContext;
  env?: NodeJS.ProcessEnv;
  promptModel?: (request: { model: string; messages: MagiMessage[] }) => Promise<{ text: string }>;
}): Promise<HookResult[]> {
  const results: HookResult[] = [];
  for (const hook of input.hooks) {
    if (hook.event !== input.event || !matchesHookCondition(hook.if, input.context)) {
      continue;
    }
    try {
      const result =
        hook.type === "command"
          ? await runCommandHook(hook, input.context, input.env)
          : hook.type === "http"
            ? await runHttpHook(hook, input.context, input.env)
            : hook.type === "prompt"
              ? await runPromptHook(hook, input.context, input.promptModel)
              : unsupportedHookResult(hook);
      results.push(result);
    } catch (error) {
      results.push({
        hook,
        output: "",
        exitCode: null,
        blocked: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}

async function runPromptHook(
  hook: HookDefinition,
  context: HookContext,
  promptModel:
    | ((request: { model: string; messages: MagiMessage[] }) => Promise<{ text: string }>)
    | undefined
): Promise<HookResult> {
  if (!hook.prompt) {
    return {
      hook,
      output: "",
      exitCode: null,
      blocked: false,
      error: "Prompt hook requires prompt"
    };
  }
  if (!hook.model) {
    return {
      hook,
      output: "",
      exitCode: null,
      blocked: false,
      error: "Prompt hook requires explicit model"
    };
  }
  if (!promptModel) {
    return {
      hook,
      output: "",
      exitCode: null,
      blocked: false,
      error: "Prompt hook requires a model runner"
    };
  }
  const prompt = hook.prompt.replace(/\$ARGUMENTS/g, JSON.stringify(context));
  const response = await promptModel({
    model: hook.model,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: prompt }]
      }
    ]
  });
  return {
    hook,
    output: response.text,
    exitCode: 0,
    blocked: false
  };
}

export function matchesHookCondition(condition: string | undefined, context: HookContext): boolean {
  if (!condition || !condition.trim()) {
    return true;
  }
  const trimmed = condition.trim();
  const equality = /^([A-Za-z][A-Za-z0-9_.]*):(.+)$/.exec(trimmed);
  if (equality) {
    return hookContextValue(context, equality[1]) === equality[2].trim();
  }
  const parsed = /^([A-Za-z0-9_]+)\((.*)\)$/.exec(trimmed);
  if (parsed) {
    if (parsed[1] !== context.toolName) {
      return false;
    }
    const selector = parsed[2];
    if (selector === "*") {
      return true;
    }
    return globMatches(selector, toolSelectorHaystack(context));
  }
  return globMatches(
    trimmed,
    [
      context.toolName,
      context.notificationType,
      context.source,
      context.agentType,
      context.taskSubject,
      context.filePath,
      context.event
    ]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
  );
}

async function runCommandHook(
  hook: HookDefinition,
  context: HookContext,
  env: NodeJS.ProcessEnv = process.env
): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const shell = createShellInvocation(hook.command ?? "");
    const child = spawn(shell.executable, shell.args, {
      cwd: context.cwd,
      env: {
        ...process.env,
        ...env,
        ARGUMENTS: JSON.stringify(context)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, hook.timeoutMs ?? 30_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        hook,
        output: timedOut
          ? `Hook timed out after ${hook.timeoutMs ?? 30_000}ms`
          : stdout.trimEnd() || stderr.trimEnd(),
        exitCode,
        blocked: exitCode === 2,
        timedOut
      });
    });
  });
}

async function runHttpHook(
  hook: HookDefinition,
  context: HookContext,
  env: NodeJS.ProcessEnv = process.env
): Promise<HookResult> {
  if (!hook.url) {
    return {
      hook,
      output: "",
      exitCode: null,
      blocked: false,
      error: "HTTP hook requires url"
    };
  }

  const timeoutMs = hook.timeoutMs ?? 30_000;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...interpolateHeaders(hook, env)
      },
      body: JSON.stringify(context),
      signal: controller.signal
    });
    const output = await response.text();
    return {
      hook,
      output,
      exitCode: response.ok ? 0 : 1,
      blocked: response.status === 403,
      status: response.status
    };
  } catch (error) {
    if (timedOut) {
      return {
        hook,
        output: `Hook timed out after ${timeoutMs}ms`,
        exitCode: null,
        blocked: false,
        timedOut: true,
        error: "HTTP hook timed out"
      };
    }
    return {
      hook,
      output: "",
      exitCode: null,
      blocked: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

function unsupportedHookResult(hook: HookDefinition): HookResult {
  return {
    hook,
    output: "",
    exitCode: null,
    blocked: false,
    error: `Hook type ${hook.type} is not implemented`
  };
}

function interpolateHeaders(hook: HookDefinition, env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(hook.headers ?? {})) {
    headers[key] = value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
      if (!isAllowedHeaderEnv(name, hook.allowedEnvVars)) {
        return "";
      }
      return env[name] ?? "";
    });
  }
  return headers;
}

function isAllowedHeaderEnv(name: string, allowedEnvVars: string[] | undefined): boolean {
  return name.startsWith("MAGI_") || (allowedEnvVars ?? []).includes(name);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function toolSelectorHaystack(context: HookContext): string {
  return String(
    context.toolInput?.command ??
      context.toolInput?.file_path ??
      context.toolInput?.filePath ??
      context.toolInput?.pattern ??
      context.toolInput?.url ??
      context.toolInput?.setting ??
      context.toolInput?.skill ??
      context.toolInput?.query ??
      ""
  );
}

function hookContextValue(context: HookContext, key: string): string | undefined {
  const value = key.split(".").reduce<unknown>((current, part) => {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[part];
  }, context);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function globMatches(pattern: string, value: string): boolean {
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
  return regex.test(value);
}
