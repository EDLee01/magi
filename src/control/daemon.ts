/**
 * Daemon mode: run the control server in the background with a PID file
 * and log file, plus start/stop/status lifecycle commands.
 */

import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  openSync,
  closeSync
} from "node:fs";
import path from "node:path";

import { atomicWrite } from "../fs-utils.js";
import { MagiPaths } from "../paths.js";

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  port?: number;
  bind?: string;
  startedAt?: string;
  pidFile: string;
  logFile: string;
}

export interface DaemonControlCredentials {
  deviceId: string;
  token: string;
  expiresAt: string;
}

function daemonDir(paths: MagiPaths): string {
  return path.join(paths.stateRoot, "daemon");
}

function pidFile(paths: MagiPaths): string {
  return path.join(daemonDir(paths), "magi.pid");
}

function logFile(paths: MagiPaths): string {
  return path.join(paths.logsRoot, "magi-daemon.log");
}

export function daemonControlCredentialsFile(paths: MagiPaths): string {
  return path.join(daemonDir(paths), "control-credentials.json");
}

export function getDaemonStatus(paths: MagiPaths): DaemonStatus {
  const pidPath = pidFile(paths);
  const logPath = logFile(paths);
  if (!existsSync(pidPath)) {
    return { running: false, pidFile: pidPath, logFile: logPath };
  }
  try {
    const raw = readFileSync(pidPath, "utf8").trim();
    const lines = raw.split("\n");
    const pid = Number(lines[0]);
    if (!Number.isFinite(pid)) {
      return { running: false, pidFile: pidPath, logFile: logPath };
    }
    // Check if the process is alive
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (!alive) {
      // Stale PID file
      try {
        unlinkSync(pidPath);
      } catch {}
      return { running: false, pidFile: pidPath, logFile: logPath };
    }
    // Parse extra metadata
    const meta: Record<string, string> = {};
    for (const line of lines.slice(1)) {
      const idx = line.indexOf("=");
      if (idx > 0) meta[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return {
      running: true,
      pid,
      port: meta.port ? Number(meta.port) : undefined,
      bind: meta.bind,
      startedAt: meta.startedAt,
      pidFile: pidPath,
      logFile: logPath
    };
  } catch {
    return { running: false, pidFile: pidPath, logFile: logPath };
  }
}

export function writeDaemonPidFile(
  paths: MagiPaths,
  info: { pid: number; port: number; bind: string }
): void {
  const dir = ensureDaemonDir(paths);
  mkdirSync(paths.logsRoot, { recursive: true });
  atomicWrite(
    pidFile(paths),
    [
      String(info.pid),
      `port=${info.port}`,
      `bind=${info.bind}`,
      `startedAt=${new Date().toISOString()}`
    ].join("\n") + "\n",
    { mode: 0o600 }
  );
}

export function writeDaemonControlCredentials(
  paths: MagiPaths,
  credentials: DaemonControlCredentials
): void {
  ensureDaemonDir(paths);
  atomicWrite(daemonControlCredentialsFile(paths), `${JSON.stringify(credentials, null, 2)}\n`, {
    mode: 0o600
  });
}

export function readDaemonControlCredentials(
  paths: MagiPaths
): DaemonControlCredentials | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(daemonControlCredentialsFile(paths), "utf8")
    ) as Partial<DaemonControlCredentials>;
    if (
      typeof parsed.deviceId !== "string" ||
      typeof parsed.token !== "string" ||
      typeof parsed.expiresAt !== "string"
    ) {
      return undefined;
    }
    return {
      deviceId: parsed.deviceId,
      token: parsed.token,
      expiresAt: parsed.expiresAt
    };
  } catch {
    return undefined;
  }
}

export function clearDaemonControlCredentials(paths: MagiPaths): void {
  try {
    unlinkSync(daemonControlCredentialsFile(paths));
  } catch {}
}

export function clearDaemonPidFile(paths: MagiPaths): void {
  const pidPath = pidFile(paths);
  if (existsSync(pidPath)) {
    try {
      unlinkSync(pidPath);
    } catch {}
  }
}

/**
 * Start the daemon by spawning a detached child process.
 * The child runs `magi serve` (or equivalent) with stdout/stderr redirected to the log file.
 */
export function startDaemon(
  paths: MagiPaths,
  input: {
    binPath: string; // path to the magi CLI script (process.argv[1])
    nodePath?: string; // node binary path
    env?: NodeJS.ProcessEnv;
  }
): { pid: number; logFile: string; pidFile: string } {
  const status = getDaemonStatus(paths);
  if (status.running) {
    throw new Error(`Magi daemon is already running (pid ${status.pid})`);
  }
  const dir = ensureDaemonDir(paths);
  mkdirSync(paths.logsRoot, { recursive: true });
  const log = logFile(paths);
  const out = openSync(log, "a");
  try {
    const child = spawn(input.nodePath ?? process.execPath, [input.binPath, "serve"], {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, ...input.env, MAGI_DAEMON: "1" }
    });
    child.unref();
    if (!child.pid) {
      throw new Error("Failed to spawn daemon process");
    }
    // Note: PID file is written by the child after server actually binds (in serve command).
    // For now, write a tentative one with just the PID so status can find it.
    atomicWrite(
      pidFile(paths),
      [String(child.pid), "port=0", "bind=", `startedAt=${new Date().toISOString()}`].join("\n") +
        "\n",
      { mode: 0o600 }
    );
    return { pid: child.pid, logFile: log, pidFile: pidFile(paths) };
  } finally {
    closeSync(out);
  }
}

export function stopDaemon(
  paths: MagiPaths,
  signal: NodeJS.Signals = "SIGTERM"
): { stopped: boolean; pid?: number } {
  const status = getDaemonStatus(paths);
  if (!status.running || !status.pid) {
    return { stopped: false };
  }
  try {
    process.kill(status.pid, signal);
    clearDaemonPidFile(paths);
    clearDaemonControlCredentials(paths);
    return { stopped: true, pid: status.pid };
  } catch {
    return { stopped: false, pid: status.pid };
  }
}

function ensureDaemonDir(paths: MagiPaths): string {
  const dir = daemonDir(paths);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}
