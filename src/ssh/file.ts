import { spawnSync } from "node:child_process";

import { ToolError } from "../tools/errors.js";
import { buildSshArgs } from "./exec.js";

export interface SshFileReadResult {
  host: string;
  path: string;
  content: string;
  sizeBytes: number;
}

export interface SshFileWriteResult {
  host: string;
  path: string;
  sizeBytes: number;
}

/**
 * Read a file from a remote host via SSH.
 * Uses base64 encoding to safely handle binary content.
 */
export async function sshFileRead(input: {
  host: string;
  path: string;
  user?: string;
  port?: number;
}): Promise<SshFileReadResult> {
  const args = buildSshArgs(input.host, input.user, input.port);
  args.push(`base64 < ${quotePosixShell(input.path)}`);

  const result = spawnSync("ssh", args, {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024
  });

  if (result.error) {
    throw new ToolError(`SSH file read failed: ${result.error.message}`, "command-failed");
  }
  if (result.status !== 0) {
    throw new ToolError(
      `Failed to read ${input.path} on ${input.host}: ${result.stderr?.trim() || "unknown error"}`,
      "command-failed"
    );
  }

  const base64Content = result.stdout?.trim() ?? "";
  const content = Buffer.from(base64Content, "base64").toString("utf8");
  // The base64 output has a trailing newline; decode then measure original bytes
  const rawBytes = Buffer.from(base64Content, "base64");

  return {
    host: input.host,
    path: input.path,
    content,
    sizeBytes: rawBytes.length
  };
}

/**
 * Write a file to a remote host via SSH.
 * Encodes content as base64 and pipes through SSH.
 */
export async function sshFileWrite(input: {
  host: string;
  path: string;
  content: string;
  user?: string;
  port?: number;
}): Promise<SshFileWriteResult> {
  const b64 = Buffer.from(input.content, "utf8").toString("base64");

  const args = buildSshArgs(input.host, input.user, input.port);
  args.push(`base64 -d > ${quotePosixShell(input.path)}`);

  const result = spawnSync("ssh", args, {
    input: b64,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024
  });

  if (result.error) {
    throw new ToolError(`SSH file write failed: ${result.error.message}`, "command-failed");
  }
  if (result.status !== 0) {
    throw new ToolError(
      `Failed to write ${input.path} on ${input.host}: ${result.stderr?.trim() || "unknown error"}`,
      "command-failed"
    );
  }

  return {
    host: input.host,
    path: input.path,
    sizeBytes: Buffer.byteLength(input.content, "utf8")
  };
}

function quotePosixShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
