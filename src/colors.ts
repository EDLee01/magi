/**
 * Centralized ANSI color control.
 *
 * Honors the `NO_COLOR` environment variable (https://no-color.org) and the
 * `--no-color` CLI flag. When color is disabled, callers can:
 *   - check `isColorEnabled()` and skip emitting escapes themselves, or
 *   - rely on the global stdout/stderr filter installed by `setColorEnabled(false)`,
 *     which strips ANSI escapes from every write.
 *
 * The flag is process-global. Color decisions are stable for the lifetime of
 * the process — set it once during CLI argv parsing.
 */

let enabled = computeDefault();
let patched = false;
let originalStdoutWrite: typeof process.stdout.write | undefined;
let originalStderrWrite: typeof process.stderr.write | undefined;

// If the default is "no color" (NO_COLOR set, or non-TTY), install the filter
// immediately so even pre-CLI imports get stripped output.
if (!enabled) installFilter();

function computeDefault(): boolean {
  // NO_COLOR: any non-empty value disables color, per the spec.
  if (process.env.NO_COLOR && process.env.NO_COLOR !== "") return false;
  // FORCE_COLOR=0 also disables; any other non-empty value enables.
  if (process.env.FORCE_COLOR === "0") return false;
  // Non-TTY stdout defaults to no color (e.g. piped to a file or another process).
  if (!process.stdout.isTTY) return false;
  return true;
}

export function isColorEnabled(): boolean {
  return enabled;
}

export function setColorEnabled(value: boolean): void {
  enabled = value;
  if (!value) installFilter();
  else uninstallFilter();
}

/**
 * Strip ANSI CSI sequences (color, cursor moves, clears) from a string.
 * This handles the common cases used in this codebase:
 *   - SGR (m): \x1b[...m
 *   - cursor (A/B/C/D, K, J, etc.): \x1b[...<letter>
 *   - bracketed paste enable/disable: \x1b[?2004h / \x1b[?2004l
 */
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, "");
}

/**
 * Returns input as-is when color is enabled, stripped when disabled.
 * Use at write boundaries when the global filter isn't appropriate.
 */
export function maybeStrip(input: string): string {
  return enabled ? input : stripAnsi(input);
}

function installFilter(): void {
  if (patched) return;
  patched = true;
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = makeFilter(
    originalStdoutWrite as unknown as (...args: unknown[]) => boolean
  ) as typeof process.stdout.write;
  process.stderr.write = makeFilter(
    originalStderrWrite as unknown as (...args: unknown[]) => boolean
  ) as typeof process.stderr.write;
}

function uninstallFilter(): void {
  if (!patched) return;
  if (originalStdoutWrite) process.stdout.write = originalStdoutWrite;
  if (originalStderrWrite) process.stderr.write = originalStderrWrite;
  patched = false;
  originalStdoutWrite = undefined;
  originalStderrWrite = undefined;
}

function makeFilter(orig: (...args: unknown[]) => boolean) {
  return function filtered(chunk: unknown, ...args: unknown[]): boolean {
    if (typeof chunk === "string") {
      return orig(stripAnsi(chunk), ...args);
    }
    if (Buffer.isBuffer(chunk)) {
      return orig(stripAnsi(chunk.toString("utf8")), ...args);
    }
    return orig(chunk, ...args);
  };
}
