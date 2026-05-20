/**
 * Animated spinner for model thinking state.
 * Shows braille dots animation with elapsed time.
 * Clears itself when stopped.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STALL_MS = 15_000;

export interface SpinnerStatus {
  /** Optional model name to show */
  model?: string;
  /** Token counts to show as `↑1.2k ↓300` */
  inputTokens?: number;
  outputTokens?: number;
  /** Optional short status text (e.g. "Bash: npm test"). Replaces "Thinking…". */
  text?: string;
}

export interface Spinner {
  stop(): void;
  /** Update visible status. Safe to call frequently; renders on next tick. */
  update(status: SpinnerStatus): void;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function startSpinner(output: { write(s: string): void }, initial?: SpinnerStatus): Spinner {
  let frame = 0;
  const start = Date.now();
  let stopped = false;
  let status: SpinnerStatus = initial ?? {};

  const interval = setInterval(() => {
    if (stopped) return;
    const elapsedMs = Date.now() - start;
    const elapsed = (elapsedMs / 1000).toFixed(1);
    const char = FRAMES[frame % FRAMES.length];
    const stalled = elapsedMs > STALL_MS;
    const color = stalled ? "\x1b[33m" : "\x1b[36m";
    const reset = "\x1b[39m";
    const dim = "\x1b[90m";
    const message = status.text ?? "Thinking";
    const parts = [`${color}${char}${reset} ${message}`];
    if (status.model) parts.push(`${dim}${status.model}${reset}`);
    if (status.inputTokens !== undefined && status.outputTokens !== undefined) {
      parts.push(`${dim}↑${formatTokens(status.inputTokens)} ↓${formatTokens(status.outputTokens)}${reset}`);
    }
    parts.push(`${dim}${elapsed}s${reset}`);
    output.write(`\r\x1b[K${parts.join("  ")}`);
    frame++;
  }, 80);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      // Clear the spinner line
      output.write("\r\x1b[K");
    },
    update(next: SpinnerStatus) {
      status = { ...status, ...next };
    }
  };
}
