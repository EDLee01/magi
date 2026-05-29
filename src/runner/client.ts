import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import { MagiUsageError } from "../errors.js";

export interface RunnerCommand {
  command: string;
  args: string[];
}

export interface RunnerInitializeResult {
  runner: string;
  version: string;
  capabilities: string[];
}

export interface RunnerPingResult {
  ok: boolean;
}

export interface RunnerProcessResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunnerPtySmokeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface RunnerAuditEvent {
  action: string;
  target?: string;
  metadata?: Record<string, unknown>;
}

export interface RunnerApplyPatchResult {
  path: string;
  diff: string;
  approved: boolean;
  auditEvent: RunnerAuditEvent;
}

export class RunnerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: readline.Interface;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
    }
  >();

  constructor(
    private readonly input: {
      command: RunnerCommand;
      env?: NodeJS.ProcessEnv;
    }
  ) {
    this.child = spawn(input.command.command, input.command.args, {
      env: { ...process.env, ...input.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code) => {
      this.rejectAll(new Error(`magi-runner exited with code ${code}`));
    });
  }

  async initialize(): Promise<RunnerInitializeResult> {
    const result = await this.request("initialize", {});
    if (
      !isRecord(result) ||
      typeof result.runner !== "string" ||
      typeof result.version !== "string"
    ) {
      throw new MagiUsageError("magi-runner initialize returned an invalid response");
    }
    return {
      runner: result.runner,
      version: result.version,
      capabilities: Array.isArray(result.capabilities)
        ? result.capabilities.filter(
            (capability): capability is string => typeof capability === "string"
          )
        : []
    };
  }

  async ping(): Promise<RunnerPingResult> {
    const result = await this.request("ping", {});
    if (!isRecord(result) || result.ok !== true) {
      throw new MagiUsageError("magi-runner ping returned an invalid response");
    }
    return { ok: true };
  }

  async echo(text: string): Promise<string> {
    const result = await this.request("echo", { text });
    if (!isRecord(result) || typeof result.text !== "string") {
      throw new MagiUsageError("magi-runner echo returned an invalid response");
    }
    return result.text;
  }

  async runProcess(input: {
    command: string;
    cwd: string;
    timeoutMs?: number;
  }): Promise<RunnerProcessResult> {
    const result = await this.request("process.run", {
      command: input.command,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? 30_000
    });
    if (!isRunnerProcessResult(result)) {
      throw new MagiUsageError("magi-runner process.run returned an invalid response");
    }
    return result;
  }

  async ptySmoke(): Promise<RunnerPtySmokeResult> {
    const result = await this.request("pty.smoke", {});
    if (
      !isRecord(result) ||
      typeof result.ok !== "boolean" ||
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string"
    ) {
      throw new MagiUsageError("magi-runner pty.smoke returned an invalid response");
    }
    return {
      ok: result.ok,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  async applyPatch(input: {
    cwd: string;
    filePath: string;
    content: string;
    approved: boolean;
  }): Promise<RunnerApplyPatchResult> {
    const result = await this.request("file.applyPatch", {
      cwd: input.cwd,
      filePath: input.filePath,
      content: input.content,
      approved: input.approved
    });
    if (!isRunnerApplyPatchResult(result)) {
      throw new MagiUsageError("magi-runner file.applyPatch returned an invalid response");
    }
    return result;
  }

  close(): void {
    this.lines.close();
    this.child.kill("SIGTERM");
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${payload}\n`, "utf8");
    });
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.id !== "number") {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new MagiUsageError(readJsonRpcError(message.error)));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function resolveRunnerCommand(env: NodeJS.ProcessEnv = process.env): RunnerCommand {
  return {
    command: env.MAGI_RUNNER_BIN ?? "magi-runner",
    args: parseRunnerArgs(env.MAGI_RUNNER_ARGS)
  };
}

function parseRunnerArgs(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new MagiUsageError("MAGI_RUNNER_ARGS must be a JSON string array");
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new MagiUsageError("MAGI_RUNNER_ARGS must be a JSON string array");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonRpcError(value: unknown): string {
  if (isRecord(value) && typeof value.message === "string") {
    return value.message;
  }
  return JSON.stringify(value);
}

function isRunnerProcessResult(value: unknown): value is RunnerProcessResult {
  return (
    isRecord(value) &&
    typeof value.command === "string" &&
    typeof value.cwd === "string" &&
    (typeof value.exitCode === "number" || value.exitCode === null) &&
    typeof value.stdout === "string" &&
    typeof value.stderr === "string" &&
    typeof value.timedOut === "boolean"
  );
}

function isRunnerApplyPatchResult(value: unknown): value is RunnerApplyPatchResult {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.diff === "string" &&
    value.approved === true &&
    isRecord(value.auditEvent) &&
    typeof value.auditEvent.action === "string" &&
    (typeof value.auditEvent.target === "string" || value.auditEvent.target === undefined) &&
    (isRecord(value.auditEvent.metadata) || value.auditEvent.metadata === undefined)
  );
}
