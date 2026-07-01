/**
 * Bracketed paste handling for the TUI.
 *
 * Modern terminals send ESC[200~ ... ESC[201~ around pasted content. This
 * lets us reliably tell typing apart from pasting:
 *   - short single-line pastes are inserted directly into the line buffer
 *   - long or multi-line pastes are replaced with a `[paste #N: ...]`
 *     placeholder and the real content is stashed; on submit the caller
 *     calls `restorePastes()` to swap the placeholder back to the real text
 *
 * We also intercept stdin's `data` listeners before readline sees them so
 * we can split out paste markers without confusing readline's editor state.
 *
 * The TUI is the only consumer; this module is intentionally tied to the
 * Node `readline/promises` Interface and `process.stdin`-shaped streams.
 */

import { Interface as ReadlinePromisesInterface } from "node:readline/promises";

// Minimal shape of what we need from stdin / stdout. Lets tests pass mocks.
export interface PasteInputStream {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  listeners(event: "data"): Function[];
  removeListener(event: "data", listener: (chunk: Buffer) => void): unknown;
}

export interface PasteOutputStream {
  write(chunk: string): boolean;
}

export interface PasteHandle {
  /**
   * Restore paste placeholders in `line` back to their original content.
   * Call this on every submitted line. Returns the resolved text and clears
   * the stash if any substitution happened.
   */
  restorePastes(line: string): string;
  /** Disable bracketed paste mode (e.g. on exit). Idempotent. */
  dispose(): void;
}

const PASTE_START = Buffer.from("\x1b[200~");
const PASTE_END = Buffer.from("\x1b[201~");
const PASTE_PLACEHOLDER_PREFIX = "<<paste #";

function formatPastePlaceholder(counter: number, charCount: number, lineCount: number): string {
  return `${PASTE_PLACEHOLDER_PREFIX}${counter}: ${charCount} chars, ${lineCount} lines>>`;
}

export function installPasteHandler(input: {
  rl: ReadlinePromisesInterface;
  stdin: PasteInputStream;
  stdout: PasteOutputStream;
}): PasteHandle {
  const { rl, stdin, stdout } = input;

  // Get readline's internal symbols so we can feed paste content into the
  // line buffer (rather than submit it).
  const rlProto = Object.getPrototypeOf(Object.getPrototypeOf(rl));
  const kInsertString = Object.getOwnPropertySymbols(rlProto).find(
    (s) => s.toString() === "Symbol(_insertString)"
  );

  // Enable bracketed paste mode.
  stdout.write("\x1b[?2004h");

  // Stash for paste content: the visible buffer shows "[paste #N: M lines]"
  // but the actual content is restored when the user presses Enter.
  const pasteStash = new Map<string, string>();
  let pasteCounter = 0;
  let pasteBuffer: string | null = null;

  // Intercept the data stream BEFORE readline sees it.
  const origDataListeners = stdin.listeners("data") as Array<(buf: Buffer) => void>;
  for (const l of origDataListeners) stdin.removeListener("data", l);
  let leftover = Buffer.alloc(0);

  const onData = (buf: Buffer) => {
    leftover = Buffer.concat([leftover, buf]);
    while (leftover.length > 0) {
      if (pasteBuffer !== null) {
        const endIdx = leftover.indexOf(PASTE_END);
        if (endIdx === -1) {
          pasteBuffer += leftover.toString("utf8");
          leftover = Buffer.alloc(0);
          return;
        }
        pasteBuffer += leftover.slice(0, endIdx).toString("utf8");
        const completed = pasteBuffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        pasteBuffer = null;
        leftover = leftover.slice(endIdx + PASTE_END.length);
        if (completed.length > 0) {
          const lineCount = completed.split("\n").length;
          if (lineCount === 1 && completed.length < 200) {
            // Short single-line paste — insert directly.
            if (kInsertString && (rl as any)[kInsertString]) {
              (rl as any)[kInsertString](completed);
            }
          } else {
            // Multi-line or long paste — show placeholder, stash real content.
            pasteCounter += 1;
            const placeholder = formatPastePlaceholder(pasteCounter, completed.length, lineCount);
            pasteStash.set(placeholder, completed);
            if (kInsertString && (rl as any)[kInsertString]) {
              (rl as any)[kInsertString](placeholder);
            }
          }
        }
        continue;
      }
      const startIdx = leftover.indexOf(PASTE_START);
      if (startIdx === -1) {
        // No paste start — pass everything to readline.
        for (const listener of origDataListeners) listener(leftover);
        leftover = Buffer.alloc(0);
        return;
      }
      if (startIdx > 0) {
        const before = leftover.slice(0, startIdx);
        for (const listener of origDataListeners) listener(before);
      }
      pasteBuffer = "";
      leftover = leftover.slice(startIdx + PASTE_START.length);
    }
  };

  stdin.on("data", onData);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stdout.write("\x1b[?2004l");
  };
  process.on("exit", dispose);

  return {
    restorePastes(line: string): string {
      if (pasteStash.size === 0 || !line.includes(PASTE_PLACEHOLDER_PREFIX)) return line;
      let result = line;
      for (const [placeholder, content] of pasteStash) {
        if (placeholder.startsWith(PASTE_PLACEHOLDER_PREFIX)) {
          result = result.split(placeholder).join(content);
        }
      }
      pasteStash.clear();
      return result;
    },
    dispose
  };
}
