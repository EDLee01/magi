/**
 * Structured JSON-line logger with size-based rotation.
 *
 * Each log entry is one JSON object per line:
 *   {"ts":"2026-05-19T10:00:00Z","level":"info","msg":"...","ctx":{...}}
 *
 * When the active file exceeds `maxBytes`, it's renamed to `<file>.1` and a
 * fresh file is opened. We keep up to `maxFiles` total (rotated files
 * `.1` ... `.N`, oldest dropped).
 *
 * Errors during logging are deliberately swallowed — logging must never crash
 * the agent.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerOptions {
  /** Path to the active log file. */
  filePath: string;
  /** Roll the file when it exceeds this many bytes. Default 5 MB. */
  maxBytes?: number;
  /** Keep this many rotated files (.1 ... .N). Default 5. */
  maxFiles?: number;
  /** Minimum level to write. Default "info". */
  level?: LogLevel;
}

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  close(): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function createJsonLogger(options: LoggerOptions): Logger {
  const filePath = options.filePath;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 5;
  const minLevel = options.level ?? "info";
  const minThreshold = LEVEL_ORDER[minLevel];

  // Ensure parent dir exists
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {}
  let fd: number | undefined;
  let bytesWritten = currentSize(filePath);

  function open(): number {
    if (fd !== undefined) return fd;
    // Logs may capture prompts and tool context — owner-only.
    fd = openSync(filePath, "a", 0o600);
    return fd;
  }

  function rotateIfNeeded(): void {
    if (bytesWritten < maxBytes) return;
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
      fd = undefined;
    }
    // Shift .N → .N+1, drop oldest
    for (let i = maxFiles - 1; i >= 1; i--) {
      const src = `${filePath}.${i}`;
      const dst = `${filePath}.${i + 1}`;
      if (existsSync(src)) {
        if (i + 1 > maxFiles) {
          try {
            unlinkSync(src);
          } catch {}
        } else {
          try {
            renameSync(src, dst);
          } catch {}
        }
      }
    }
    if (existsSync(filePath)) {
      try {
        renameSync(filePath, `${filePath}.1`);
      } catch {}
    }
    bytesWritten = 0;
  }

  function write(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < minThreshold) return;
    try {
      const entry = ctx
        ? { ts: new Date().toISOString(), level, msg, ctx }
        : { ts: new Date().toISOString(), level, msg };
      const line = JSON.stringify(entry) + "\n";
      const buf = Buffer.from(line, "utf8");
      rotateIfNeeded();
      const handle = open();
      writeSync(handle, buf, 0, buf.length);
      bytesWritten += buf.length;
    } catch {
      // Logging must never throw
    }
  }

  return {
    debug: (msg, ctx) => write("debug", msg, ctx),
    info: (msg, ctx) => write("info", msg, ctx),
    warn: (msg, ctx) => write("warn", msg, ctx),
    error: (msg, ctx) => write("error", msg, ctx),
    close: () => {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {}
        fd = undefined;
      }
    }
  };
}

function currentSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}
