import { spawn } from "node:child_process";

import { ToolError } from "./errors.js";

export interface ShellResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function isDangerousShellCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return [
    /\brm\s+(-[a-z]*[rf][a-z]*|-r\s+-f|-f\s+-r)\b/,
    /\bsudo\b/,
    /\bmkfs\b/,
    /\bdd\s+.*\bof=/,
    /\bchmod\s+777\b/,
    />\s*\/etc\//,
    /\bcurl\b.*\|\s*(sh|bash)\b/,
    /\bwget\b.*\|\s*(sh|bash)\b/
  ].some((pattern) => pattern.test(normalized));
}

export async function runShellCommand(input: {
  cwd: string;
  command: string;
  timeoutMs?: number;
  approveDangerous?: boolean;
}): Promise<ShellResult> {
  if (isDangerousShellCommand(input.command) && !input.approveDangerous) {
    throw new ToolError(`Command requires explicit approval: ${input.command}`, "approval-required");
  }

  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", input.command], {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs ?? 30_000);

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
      if (timedOut) {
        reject(new ToolError(`Command timed out after ${input.timeoutMs ?? 30_000}ms: ${input.command}`, "timeout"));
        return;
      }
      resolve({
        command: input.command,
        cwd: input.cwd,
        exitCode,
        stdout,
        stderr,
        timedOut
      });
    });
  });
}
