import { spawnSync } from "node:child_process";

import { ToolError } from "../tools/errors.js";

export interface SshHostConfig {
  host: string;
  user?: string;
  port?: number;
}

export interface SshExecResult {
  host: string;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export async function sshExec(input: {
  host: string;
  command: string;
  user?: string;
  port?: number;
  timeoutMs?: number;
}): Promise<SshExecResult> {
  const args = buildSshArgs(input.host, input.user, input.port);

  // Pass the command as the final argument to ssh
  args.push(input.command);

  const result = spawnSync("ssh", args, {
    encoding: "utf8",
    timeout: input.timeoutMs ?? 30_000,
    maxBuffer: 10 * 1024 * 1024 // 10MB
  });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new ToolError(`SSH connection to ${input.host} timed out after ${input.timeoutMs ?? 30_000}ms`, "timeout");
    }
    throw new ToolError(`SSH failed: ${result.error.message}`, "command-failed");
  }

  return {
    host: input.host,
    command: input.command,
    exitCode: result.status,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? ""
  };
}

export function buildSshArgs(host: string, user?: string, port?: number): string[] {
  const args = [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    "-o", "BatchMode=yes"
  ];

  if (port) {
    args.push("-p", String(port));
  }

  const target = user ? `${user}@${host}` : host;
  args.push(target);

  return args;
}
