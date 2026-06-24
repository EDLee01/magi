import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createShellInvocation, isWindowsPlatform } from "../platform/shell.js";
import { ToolError } from "./errors.js";

export interface ShellResult {
  command: string;
  cwd: string;
  shell: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Default foreground shell timeout. 30s was too short for common real commands
 * (npm install, builds, test suites), which then got killed mid-run. Default
 * to 2 minutes, overridable per call via timeout_ms or globally via
 * MAGI_BASH_TIMEOUT_MS. Long-running servers are auto-backgrounded separately
 * and never hit this.
 */
export function resolveDefaultShellTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MAGI_BASH_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

const LONG_RUNNING_PATTERNS = [
  /\bnpm\s+run\s+dev\b/,
  /\bnpm\s+run\s+start\b/,
  /\bnpm\s+start\b/,
  /\byarn\s+dev\b/,
  /\byarn\s+start\b/,
  /\bpnpm\s+dev\b/,
  /\bpnpm\s+start\b/,
  /\bvite(\s|$)/,
  /\bnext\s+dev\b/,
  /\bnuxt\s+dev\b/,
  /\buvicorn\b/,
  /\bflask\s+run\b/,
  /\bdjango.*runserver\b/,
  /\bpython\s+-m\s+http\.server\b/,
  /\bpython\s+-m\s+SimpleHTTPServer\b/,
  /\bnode\s+.*server\b/,
  /\bdeno\s+run\b/,
  /\bbun\s+run\s+dev\b/,
  /\bbun\s+dev\b/
];

export function isLongRunningCommand(command: string): boolean {
  const trimmed = command.trim();
  if (/&\s*$/.test(trimmed)) return false;
  if (hasBackgroundedLongRunningSegment(trimmed)) return false;
  return LONG_RUNNING_PATTERNS.some((p) => p.test(trimmed));
}

function hasBackgroundedLongRunningSegment(command: string): boolean {
  let segmentStart = 0;
  for (let index = 0; index < command.length; index++) {
    if (!isBackgroundOperator(command, index)) {
      continue;
    }
    const segment = command.slice(segmentStart, index);
    if (LONG_RUNNING_PATTERNS.some((pattern) => pattern.test(segment))) {
      return true;
    }
    segmentStart = index + 1;
  }
  return false;
}

function isBackgroundOperator(command: string, index: number): boolean {
  if (command[index] !== "&") return false;
  const prev = command[index - 1];
  const next = command[index + 1];
  return prev !== "&" && next !== "&" && prev !== ">";
}

export function isDangerousShellCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return [
    // rm with recursive/force, in short (-rf, -r -f), long (--recursive,
    // --force) or grouped/separated forms.
    /\brm\b[^|;&\n]*\s-[a-z]*[rf][a-z]*\b/,
    /\brm\b[^|;&\n]*--(recursive|force)\b/,
    // find used to delete or exec arbitrary commands over a tree.
    /\bfind\b[^|;&\n]*-delete\b/,
    /\bfind\b[^|;&\n]*-exec\b/,
    /\bsudo\b/,
    /\bmkfs\b/,
    /\bdd\s+.*\bof=/,
    // chmod world-writable in any form: numeric mode (3-4 octal digits) whose
    // final digit has the world-write bit set (2,3,6,7) — covers 777, 0777,
    // 666, with or without -R/--recursive — and symbolic o+w / a+w.
    /\bchmod\b[^|;&\n]*\b[0-7]?[0-7][0-7][2367]\b/,
    /\bchmod\b[^|;&\n]*[ugoa]*\+w/,
    /\bchown\b[^|;&\n]*--?r(ecursive)?\b/,
    />\s*\/etc\//,
    // piping a download straight into a shell, incl. sh/bash/zsh/python.
    /\b(curl|wget|fetch)\b[^|;&\n]*\|\s*(sudo\s+)?(sh|bash|zsh|ksh|python[0-9.]*|perl|ruby|node)\b/,
    // overwrite a block device or core system path.
    />\s*\/dev\/(sd|nvme|hd|vd)/,
    // fork bomb
    /:\(\)\s*\{.*:\|:.*\}/
  ].some((pattern) => pattern.test(normalized));
}

// Operators that start a *new* command or a command substitution. A simple
// "prefix:*" allow rule (e.g. Bash(git:*)) must not authorize a command line
// containing any of these, otherwise `git log && rm -rf /` slips through the
// prefix check. Quoted occurrences are also rejected — that only causes an
// extra confirmation prompt (the safe direction), never an unwanted allow.
const COMMAND_CHAINING = /(\|\||&&|[;|&]|\$\(|`|\$\{|<\(|>\(|\n)/;

/**
 * True only if `command` is a single simple invocation that begins with the
 * allowed `prefix` and chains no further commands. Used by the permission
 * allow-rule matcher so prefix allow-listing cannot be bypassed with `&&`,
 * `;`, `|`, `$(...)`, backticks, etc.
 */
export function commandAllowedByPrefix(command: string, prefix: string): boolean {
  const trimmed = command.trim();
  if (trimmed !== prefix && !trimmed.startsWith(`${prefix} `)) {
    return false;
  }
  return !COMMAND_CHAINING.test(trimmed);
}

export function isReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || hasShellControlOperator(trimmed) || /[`$<>|;&]/.test(trimmed)) {
    return false;
  }
  const parts = trimmed.split(/\s+/);
  const commandName = parts[0];
  const args = parts.slice(1);
  switch (commandName) {
    case "pwd":
      return args.length === 0 || args.every(isReadOnlyFlag);
    case "ls":
      return args.every(isReadOnlyFlagOrPath);
    case "cat":
      return args.length > 0 && args.every(isReadOnlyFlagOrPath);
    case "head":
    case "wc":
      return args.length > 0 && args.every(isReadOnlyFlagOrPath);
    case "tail":
      return args.length > 0 && !args.some(isTailFollowFlag) && args.every(isReadOnlyFlagOrPath);
    case "sed":
      return isReadOnlySedArgs(args);
    case "git":
      return isReadOnlyGitArgs(args);
    default:
      return false;
  }
}

function hasShellControlOperator(command: string): boolean {
  return /\s(?:&&|\|\||;)\s/.test(command) || /\n/.test(command);
}

function isReadOnlyFlag(value: string): boolean {
  return /^-[A-Za-z0-9-]+$/.test(value);
}

function isReadOnlyFlagOrPath(value: string): boolean {
  if (isReadOnlyFlag(value)) {
    return true;
  }
  if (value === ".") {
    return true;
  }
  if (value.startsWith("/") || value.includes("..")) {
    return false;
  }
  return /^[A-Za-z0-9._/@:+,=-]+$/.test(value);
}

function isReadOnlySedArgs(args: string[]): boolean {
  if (args.length < 2) {
    return false;
  }
  if (args.some(isMutatingSedFlag)) {
    return false;
  }
  if (!args.some((arg) => arg === "-n" || /^-.*n/.test(arg))) {
    return false;
  }
  return args.every((arg) => isReadOnlyFlagOrPath(arg) || isReadOnlySedPrintScript(arg));
}

function isTailFollowFlag(value: string): boolean {
  return (
    value === "-f" ||
    value === "-F" ||
    value === "--follow" ||
    value.startsWith("--follow=") ||
    /^-[A-Za-z]*[fF][A-Za-z]*$/.test(value)
  );
}

function isMutatingSedFlag(value: string): boolean {
  return (
    value === "-i" ||
    value.startsWith("-i") ||
    value === "--in-place" ||
    value.startsWith("--in-place=")
  );
}

function isReadOnlySedPrintScript(value: string): boolean {
  const unquoted = value.replace(/^['"]|['"]$/g, "");
  return /^(\d+|\$)(,(\d+|\$))?p$/.test(unquoted);
}

function isReadOnlyGitArgs(args: string[]): boolean {
  if (args.length === 0) {
    return false;
  }
  const [subcommand, ...rest] = args;
  if (rest.some(isMutatingGitFlag)) {
    return false;
  }
  if (subcommand === "status") {
    return rest.every(isReadOnlyFlagOrPath);
  }
  if (subcommand === "diff" || subcommand === "log" || subcommand === "show") {
    return rest.every(isReadOnlyFlagOrPath);
  }
  return false;
}

function isMutatingGitFlag(value: string): boolean {
  return value === "-o" || value === "--output" || value.startsWith("--output=");
}

export async function runShellCommand(input: {
  cwd: string;
  command: string;
  timeoutMs?: number;
  approveDangerous?: boolean;
  signal?: AbortSignal;
  skipAutoBackground?: boolean;
}): Promise<ShellResult> {
  if (isDangerousShellCommand(input.command) && !input.approveDangerous) {
    throw new ToolError(
      `Command requires explicit approval: ${input.command}`,
      "approval-required"
    );
  }

  // Auto-background long-running commands (dev servers, etc.) to avoid hanging
  if (!input.skipAutoBackground && isLongRunningCommand(input.command)) {
    const bg = backgroundCommand(input.command, input.cwd);
    const bgResult = await runShellCommand({
      ...input,
      command: bg.command,
      skipAutoBackground: true
    });
    const pid = parseBackgroundPid(bgResult.stdout);
    const stopLine = pid
      ? isWindowsPlatform()
        ? `To stop: Stop-Process -Id ${pid}`
        : `To stop: kill ${pid}`
      : "To stop: use the BG_PID printed below.";
    return {
      ...bgResult,
      command: input.command,
      stdout:
        `[Auto-backgrounded] Process detached from shell. The process IS running — DO NOT try to verify by re-running it.\n` +
        `Log file: ${bg.logFile}\n` +
        `To check output: ${bg.checkCommand}\n` +
        `${stopLine}\n` +
        `Wait 3-5 seconds before checking the log for the URL/port.\n` +
        bgResult.stdout
    };
  }

  const effectiveTimeoutMs = input.timeoutMs ?? resolveDefaultShellTimeoutMs();

  return new Promise((resolve, reject) => {
    const shell = createShellInvocation(input.command);
    const child = spawn(shell.executable, shell.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: !isWindowsPlatform() // Unix process group lets us kill child trees safely.
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let stdoutEnded = false;
    let stderrEnded = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let exitCodeFromExit: number | null = null;
    const MAX_OUTPUT = 1024 * 1024; // 1MB cap per stream
    const TRUNC_NOTE = "\n[output truncated at 1MB]\n";
    const killTree = (sig: NodeJS.Signals = "SIGTERM") => {
      try {
        if (child.pid && !isWindowsPlatform()) {
          process.kill(-child.pid, sig); // negative PID = Unix process group
          return;
        }
        child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {}
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      // If still alive after 2s, escalate to SIGKILL
      killTimer = setTimeout(() => killTree("SIGKILL"), 2000);
    }, effectiveTimeoutMs);

    // Honor abort signal (e.g. user pressed Ctrl+C)
    const onAbort = () => {
      aborted = true;
      clearTimeout(timer);
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), 1000);
    };
    if (input.signal) {
      if (input.signal.aborted) {
        onAbort();
      } else {
        input.signal.addEventListener("abort", onAbort);
      }
    }

    const cleanup = () => {
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      if (killTimer) clearTimeout(killTimer);
      input.signal?.removeEventListener("abort", onAbort);
      child.stdout.removeListener("data", onStdoutData);
      child.stderr.removeListener("data", onStderrData);
      child.stdout.removeListener("end", onStdoutEnd);
      child.stderr.removeListener("end", onStderrEnd);
    };
    const finish = (exitCode: number | null, destroyStreams = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (destroyStreams) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
      if (aborted) {
        reject(new ToolError(`Command aborted: ${input.command}`, "timeout"));
        return;
      }
      if (timedOut) {
        reject(
          new ToolError(
            `Command timed out after ${effectiveTimeoutMs}ms: ${input.command}`,
            "timeout"
          )
        );
        return;
      }
      resolve({
        command: input.command,
        cwd: input.cwd,
        shell: shell.displayName,
        exitCode,
        stdout,
        stderr,
        timedOut
      });
    };
    const maybeFinishAfterExit = () => {
      if (exitCodeFromExit === null || !stdoutEnded || !stderrEnded) return;
      finish(exitCodeFromExit);
    };
    const onStdoutData = (chunk: Buffer) => {
      if (stdoutTruncated) return;
      const piece = chunk.toString("utf8");
      if (stdout.length + piece.length > MAX_OUTPUT) {
        const room = MAX_OUTPUT - stdout.length;
        if (room > 0) stdout += piece.slice(0, room);
        stdout += TRUNC_NOTE;
        stdoutTruncated = true;
      } else {
        stdout += piece;
      }
    };
    const onStderrData = (chunk: Buffer) => {
      if (stderrTruncated) return;
      const piece = chunk.toString("utf8");
      if (stderr.length + piece.length > MAX_OUTPUT) {
        const room = MAX_OUTPUT - stderr.length;
        if (room > 0) stderr += piece.slice(0, room);
        stderr += TRUNC_NOTE;
        stderrTruncated = true;
      } else {
        stderr += piece;
      }
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinishAfterExit();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinishAfterExit();
    };
    child.stdout.on("data", onStdoutData);
    child.stderr.on("data", onStderrData);
    child.stdout.on("end", onStdoutEnd);
    child.stderr.on("end", onStderrEnd);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("exit", (exitCode) => {
      exitCodeFromExit = exitCode;
      // Match geomind-agent's shell task behavior: shell exit is the command
      // boundary. Do not wait forever for background grandchildren that
      // inherited stdio; give normal pipes a short chance to drain first.
      drainTimer = setTimeout(() => finish(exitCode, true), 50);
      maybeFinishAfterExit();
    });
    child.on("close", (exitCode) => {
      finish(exitCode ?? exitCodeFromExit);
    });
  });
}

function backgroundCommand(
  command: string,
  cwd: string
): {
  command: string;
  logFile: string;
  checkCommand: string;
} {
  const logFile = join(tmpdir(), `magi-bg-${Date.now()}.log`);
  if (isWindowsPlatform()) {
    const stdoutFile = logFile;
    const stderrFile = logFile.replace(/\.log$/, ".stderr.log");
    const childCommand = psSingleQuote(command);
    return {
      command: [
        `$p = Start-Process -FilePath 'powershell.exe'`,
        `-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-Command',${childCommand})`,
        `-WorkingDirectory ${psSingleQuote(cwd)}`,
        `-RedirectStandardOutput ${psSingleQuote(stdoutFile)}`,
        `-RedirectStandardError ${psSingleQuote(stderrFile)}`,
        "-PassThru;",
        `"BG_PID=$($p.Id)";`,
        `"BG_STDERR=${stderrFile}"`
      ].join(" "),
      logFile: stdoutFile,
      checkCommand: `Get-Content ${psSingleQuote(stdoutFile)}`
    };
  }

  // Wrap the command in a subshell so compound commands work correctly.
  // Use nohup and redirect stdio so the detached process survives shell exit.
  const escaped = command.replace(/'/g, "'\\''");
  return {
    command: `nohup bash -c '${escaped}' > ${logFile} 2>&1 < /dev/null & disown; echo "BG_PID=$!"`,
    logFile,
    checkCommand: `cat ${logFile}`
  };
}

function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function parseBackgroundPid(output: string): number | undefined {
  const match = /(?:^|\n)BG_PID=(\d+)(?:\n|$)/.exec(output);
  if (!match) {
    return undefined;
  }
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}
