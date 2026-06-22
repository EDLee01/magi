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
      throw new ToolError(
        `SSH connection to ${input.host} timed out after ${input.timeoutMs ?? 30_000}ms`,
        "timeout"
      );
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

// A hostname/IP may contain letters, digits, dots, hyphens (not leading),
// colons (IPv6) and percent (zone id). It must NOT start with "-" or it would
// be parsed by ssh as an option (e.g. -oProxyCommand=...), nor contain "=",
// whitespace, or shell metacharacters. Same rule for the optional user.
const SSH_HOST_PATTERN = /^[A-Za-z0-9.:][A-Za-z0-9.:_%-]*$/;
const SSH_USER_PATTERN = /^[A-Za-z0-9._-][A-Za-z0-9._@-]*$/;

export function validateSshHost(host: string): void {
  if (!SSH_HOST_PATTERN.test(host)) {
    throw new ToolError(
      `Invalid SSH host "${host}": only letters, digits, dots, colons, hyphens and underscores are allowed, and it must not start with "-"`,
      "bad-input"
    );
  }
}

export function validateSshUser(user: string): void {
  if (!SSH_USER_PATTERN.test(user)) {
    throw new ToolError(
      `Invalid SSH user "${user}": only letters, digits, dots, hyphens, underscores and @ are allowed, and it must not start with "-"`,
      "bad-input"
    );
  }
}

export function buildSshArgs(host: string, user?: string, port?: number): string[] {
  // Reject argument-injection attempts before the value reaches ssh's argv.
  // Without this, a host like "-oProxyCommand=..." executes a local command.
  validateSshHost(host);
  if (user !== undefined) {
    validateSshUser(user);
  }

  const args = [
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes"
  ];

  if (port) {
    args.push("-p", String(port));
  }

  // "--" terminates option parsing so the target can never be read as a flag,
  // even if validation above is ever loosened.
  const target = user ? `${user}@${host}` : host;
  args.push("--", target);

  return args;
}
