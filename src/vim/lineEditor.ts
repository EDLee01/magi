// Vim mode line editor — raw stdin line input with INSERT and NORMAL modes.
// Adapted in spirit from magi's full vim state machine, but simplified for
// prompt-line editing (no Ink integration).

import { emitKeypressEvents } from "node:readline";
import { buildPromptDisplayForTest, TuiPromptSlashCommand } from "../tui/prompt-reader.js";

export type VimMode = "INSERT" | "NORMAL";

export interface VimReadLineOptions {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  prompt: string;
  initialMode?: VimMode;
  history?: string[];
  slashCommands?: TuiPromptSlashCommand[];
  onModeChange?: (mode: VimMode) => void;
}

interface State {
  buffer: string;
  cursor: number;
  mode: VimMode;
  pendingOp: "d" | "c" | "y" | null;
  yankBuffer: string;
  history: string[];
  historyIndex: number; // -1 = current line
  savedBuffer: string; // saved when scrolling history
}

/**
 * Read a single line from stdin with vim mode editing.
 * Returns the line on Enter, or rejects on Ctrl+C / Ctrl+D.
 */
export async function readLineWithVim(opts: VimReadLineOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const { input, output, prompt } = opts;
    const state: State = {
      buffer: "",
      cursor: 0,
      mode: opts.initialMode ?? "INSERT",
      pendingOp: null,
      yankBuffer: "",
      history: opts.history ?? [],
      historyIndex: -1,
      savedBuffer: ""
    };

    let renderedLines = 0;
    let renderedCursorLine = 0;

    const render = () => {
      const modeIndicator =
        state.mode === "NORMAL" ? "\x1b[33m[N]\x1b[39m " : "\x1b[36m[I]\x1b[39m ";
      const display = buildPromptDisplayForTest({
        prompt: modeIndicator + prompt,
        text: state.buffer,
        cursor: state.cursor,
        safeColumns: Math.max(20, (output.columns || 80) - 6),
        maxVisibleLines: 6,
        slashCommands: opts.slashCommands
      });

      if (renderedLines > 0) {
        if (renderedCursorLine > 0) {
          output.write(`\x1b[${renderedCursorLine}A`);
        }
        output.write("\r\x1b[J");
      }

      output.write(display.lines.join("\n"));
      const up = display.lines.length - 1 - display.cursorLine;
      if (up > 0) output.write(`\x1b[${up}A`);
      output.write("\r");
      if (display.cursorColumn > 0) output.write(`\x1b[${display.cursorColumn}C`);
      renderedLines = display.lines.length;
      renderedCursorLine = display.cursorLine;
    };

    const setMode = (mode: VimMode) => {
      state.mode = mode;
      state.pendingOp = null;
      opts.onModeChange?.(mode);
      render();
    };

    emitKeypressEvents(input);
    if (input.isTTY) {
      input.setRawMode(true);
    }
    input.resume();

    const cleanup = () => {
      if (input.isTTY) {
        input.setRawMode(false);
      }
      input.removeListener("keypress", onKey);
      const down = Math.max(0, renderedLines - 1 - renderedCursorLine);
      if (down > 0) output.write(`\x1b[${down}B`);
      output.write("\r\n");
    };

    const onKey = (
      str: string | undefined,
      key:
        | { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean; sequence?: string }
        | undefined
    ) => {
      if (!key) return;

      // Ctrl+C: cancel
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("SIGINT"));
        return;
      }
      // Ctrl+D: EOF
      if (key.ctrl && key.name === "d") {
        cleanup();
        reject(new Error("EOF"));
        return;
      }
      // Enter
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(state.buffer);
        return;
      }
      // Escape: enter NORMAL mode
      if (key.name === "escape") {
        if (state.mode === "INSERT") {
          // After exiting insert, vim moves cursor back by 1 (if not at col 0)
          if (state.cursor > 0) state.cursor--;
        }
        setMode("NORMAL");
        return;
      }

      if (state.mode === "INSERT") {
        handleInsertKey(state, str, key, render);
      } else {
        handleNormalKey(state, str, key, render, setMode);
      }
    };

    input.on("keypress", onKey);
    render();
  });
}

function handleInsertKey(
  state: State,
  str: string | undefined,
  key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string },
  render: () => void
) {
  // Backspace
  if (key.name === "backspace") {
    if (state.cursor > 0) {
      state.buffer = state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor);
      state.cursor--;
      render();
    }
    return;
  }
  // Delete
  if (key.name === "delete") {
    if (state.cursor < state.buffer.length) {
      state.buffer = state.buffer.slice(0, state.cursor) + state.buffer.slice(state.cursor + 1);
      render();
    }
    return;
  }
  // Arrow keys
  if (key.name === "left") {
    if (state.cursor > 0) {
      state.cursor--;
      render();
    }
    return;
  }
  if (key.name === "right") {
    if (state.cursor < state.buffer.length) {
      state.cursor++;
      render();
    }
    return;
  }
  if (key.name === "up") {
    historyPrev(state);
    render();
    return;
  }
  if (key.name === "down") {
    historyNext(state);
    render();
    return;
  }
  if (key.name === "home") {
    state.cursor = 0;
    render();
    return;
  }
  if (key.name === "end") {
    state.cursor = state.buffer.length;
    render();
    return;
  }
  // Ctrl+U: clear to start of line (emacs)
  if (key.ctrl && key.name === "u") {
    state.buffer = state.buffer.slice(state.cursor);
    state.cursor = 0;
    render();
    return;
  }
  // Ctrl+A: start of line
  if (key.ctrl && key.name === "a") {
    state.cursor = 0;
    render();
    return;
  }
  // Ctrl+E: end of line
  if (key.ctrl && key.name === "e") {
    state.cursor = state.buffer.length;
    render();
    return;
  }
  // Printable character
  if (str && !key.ctrl && !key.meta && str.length === 1 && str.charCodeAt(0) >= 32) {
    state.buffer = state.buffer.slice(0, state.cursor) + str + state.buffer.slice(state.cursor);
    state.cursor++;
    render();
  }
}

function handleNormalKey(
  state: State,
  str: string | undefined,
  key: { name?: string; ctrl?: boolean; sequence?: string },
  render: () => void,
  setMode: (mode: VimMode) => void
) {
  const k = str ?? key.name ?? "";

  // Pending operator + motion (e.g., dd, dw, yw, cw)
  if (state.pendingOp) {
    const op = state.pendingOp;
    state.pendingOp = null;
    if (k === op) {
      // dd, yy, cc — line operations (clear/yank entire buffer)
      if (op === "y") {
        state.yankBuffer = state.buffer;
      } else {
        state.yankBuffer = state.buffer;
        state.buffer = "";
        state.cursor = 0;
        if (op === "c") setMode("INSERT");
      }
      render();
      return;
    }
    // d{motion}, c{motion}, y{motion}
    const range = computeMotionRange(state, k);
    if (range) {
      const [start, end] = [Math.min(range.start, range.end), Math.max(range.start, range.end)];
      state.yankBuffer = state.buffer.slice(start, end);
      if (op !== "y") {
        state.buffer = state.buffer.slice(0, start) + state.buffer.slice(end);
        state.cursor = start;
        if (op === "c") setMode("INSERT");
      }
    }
    render();
    return;
  }

  // Mode switches
  if (k === "i") {
    setMode("INSERT");
    return;
  }
  if (k === "a") {
    if (state.cursor < state.buffer.length) state.cursor++;
    setMode("INSERT");
    return;
  }
  if (k === "I") {
    state.cursor = 0;
    setMode("INSERT");
    return;
  }
  if (k === "A") {
    state.cursor = state.buffer.length;
    setMode("INSERT");
    return;
  }

  // Motions
  if (k === "h" || key.name === "left") {
    if (state.cursor > 0) state.cursor--;
    render();
    return;
  }
  if (k === "l" || key.name === "right") {
    if (state.cursor < Math.max(0, state.buffer.length - 1)) state.cursor++;
    render();
    return;
  }
  if (k === "0" || key.name === "home") {
    state.cursor = 0;
    render();
    return;
  }
  if (k === "^") {
    state.cursor = firstNonBlank(state.buffer);
    render();
    return;
  }
  if (k === "$" || key.name === "end") {
    state.cursor = Math.max(0, state.buffer.length - 1);
    render();
    return;
  }
  if (k === "w") {
    state.cursor = nextWord(state.buffer, state.cursor);
    render();
    return;
  }
  if (k === "b") {
    state.cursor = prevWord(state.buffer, state.cursor);
    render();
    return;
  }
  if (k === "e") {
    state.cursor = endOfWord(state.buffer, state.cursor);
    render();
    return;
  }

  // History (j/k)
  if (k === "k" || key.name === "up") {
    historyPrev(state);
    render();
    return;
  }
  if (k === "j" || key.name === "down") {
    historyNext(state);
    render();
    return;
  }

  // Edit commands
  if (k === "x") {
    if (state.cursor < state.buffer.length) {
      state.yankBuffer = state.buffer[state.cursor]!;
      state.buffer = state.buffer.slice(0, state.cursor) + state.buffer.slice(state.cursor + 1);
      if (state.cursor >= state.buffer.length && state.cursor > 0) state.cursor--;
      render();
    }
    return;
  }
  if (k === "X") {
    if (state.cursor > 0) {
      state.yankBuffer = state.buffer[state.cursor - 1]!;
      state.buffer = state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor);
      state.cursor--;
      render();
    }
    return;
  }
  if (k === "D") {
    state.yankBuffer = state.buffer.slice(state.cursor);
    state.buffer = state.buffer.slice(0, state.cursor);
    if (state.cursor > state.buffer.length) state.cursor = Math.max(0, state.buffer.length - 1);
    render();
    return;
  }
  if (k === "C") {
    state.yankBuffer = state.buffer.slice(state.cursor);
    state.buffer = state.buffer.slice(0, state.cursor);
    setMode("INSERT");
    return;
  }
  if (k === "p") {
    state.buffer =
      state.buffer.slice(0, state.cursor + 1) +
      state.yankBuffer +
      state.buffer.slice(state.cursor + 1);
    state.cursor += state.yankBuffer.length;
    render();
    return;
  }
  if (k === "P") {
    state.buffer =
      state.buffer.slice(0, state.cursor) + state.yankBuffer + state.buffer.slice(state.cursor);
    state.cursor += state.yankBuffer.length;
    render();
    return;
  }
  // Pending operator start
  if (k === "d" || k === "c" || k === "y") {
    state.pendingOp = k as "d" | "c" | "y";
    return;
  }
}

function computeMotionRange(
  state: State,
  motion: string
): { start: number; end: number } | undefined {
  if (motion === "w") return { start: state.cursor, end: nextWord(state.buffer, state.cursor) };
  if (motion === "b") return { start: prevWord(state.buffer, state.cursor), end: state.cursor };
  if (motion === "e")
    return { start: state.cursor, end: endOfWord(state.buffer, state.cursor) + 1 };
  if (motion === "$") return { start: state.cursor, end: state.buffer.length };
  if (motion === "0") return { start: 0, end: state.cursor };
  if (motion === "h") return { start: Math.max(0, state.cursor - 1), end: state.cursor };
  if (motion === "l")
    return { start: state.cursor, end: Math.min(state.buffer.length, state.cursor + 1) };
  return undefined;
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

export function nextWord(buf: string, pos: number): number {
  let i = pos;
  // Skip current word
  while (i < buf.length && isWordChar(buf[i]!)) i++;
  // Skip whitespace
  while (i < buf.length && !isWordChar(buf[i]!)) i++;
  return i;
}

export function prevWord(buf: string, pos: number): number {
  let i = pos - 1;
  while (i >= 0 && !isWordChar(buf[i]!)) i--;
  while (i >= 0 && isWordChar(buf[i]!)) i--;
  return Math.max(0, i + 1);
}

export function endOfWord(buf: string, pos: number): number {
  let i = pos;
  if (i < buf.length && !isWordChar(buf[i]!)) {
    while (i < buf.length && !isWordChar(buf[i]!)) i++;
  }
  while (i < buf.length - 1 && isWordChar(buf[i + 1]!)) i++;
  return i;
}

export function firstNonBlank(buf: string): number {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== " " && buf[i] !== "\t") return i;
  }
  return 0;
}

function historyPrev(state: State) {
  if (state.history.length === 0) return;
  if (state.historyIndex === -1) {
    state.savedBuffer = state.buffer;
    state.historyIndex = state.history.length - 1;
  } else if (state.historyIndex > 0) {
    state.historyIndex--;
  }
  state.buffer = state.history[state.historyIndex] ?? "";
  state.cursor = state.buffer.length;
}

function historyNext(state: State) {
  if (state.historyIndex === -1) return;
  if (state.historyIndex < state.history.length - 1) {
    state.historyIndex++;
    state.buffer = state.history[state.historyIndex] ?? "";
  } else {
    state.historyIndex = -1;
    state.buffer = state.savedBuffer;
  }
  state.cursor = state.buffer.length;
}
