export type TuiPromptAbortReason = "SIGINT" | "EOF" | "ESC";

export class TuiPromptAbortError extends Error {
  constructor(readonly reason: TuiPromptAbortReason) {
    super(reason);
  }
}

export interface TuiPromptOptions {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  prompt: string;
  history?: string[];
  initialValue?: string;
  maxVisibleLines?: number;
  slashCommands?: TuiPromptSlashCommand[];
  maxSlashSuggestions?: number;
}

export interface TuiPromptSlashCommand {
  name: string;
  description: string;
  usage?: string;
  aliases?: string[];
}

interface LogicalLine {
  text: string;
  start: number;
  end: number;
}

interface Grapheme {
  segment: string;
  index: number;
  width: number;
}

interface DisplayRow {
  line: string;
  sourceLine: number;
  cursorColumn?: number;
}

interface SlashSuggestionState {
  query: string;
  visible: TuiPromptSlashCommand[];
  labels: string[];
  total: number;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const PASTE_PLACEHOLDER_PREFIX = "<<paste #";
const DIM = "\x1b[90m";
const RESET = "\x1b[0m";
let graphemeSegmenter: Intl.Segmenter | undefined;

export async function readTuiPrompt(options: TuiPromptOptions): Promise<string> {
  const { input, output, prompt } = options;
  const history = options.history ?? [];
  const maxVisibleLines = Math.max(1, options.maxVisibleLines ?? 6);
  let text = options.initialValue ?? "";
  let cursor = text.length;
  let renderedLines = 0;
  let renderedCursorLine = 0;
  let pending = "";
  let pasteBuffer: string | undefined;
  let pasteCounter = 0;
  let historyIndex = history.length;
  let draft = text;
  let slashSelection = 0;
  const pasteStash = new Map<string, string>();

  const readlineListeners = input.rawListeners("data").slice();
  for (const listener of readlineListeners) {
    input.removeListener("data", listener as (...args: unknown[]) => void);
  }

  const wasRaw = input.isRaw;
  if (input.isTTY) {
    input.setRawMode(true);
  }
  input.resume();
  output.write("\x1b[?2004h");

  let settled = false;
  let resolvePrompt!: (value: string) => void;
  let rejectPrompt!: (error: Error) => void;

  let renderTimer: ReturnType<typeof setTimeout> | undefined;

  const cleanup = () => {
    input.removeListener("data", onData);
    output.write("\x1b[?2004l");
    if (input.isTTY) {
      input.setRawMode(Boolean(wasRaw));
    }
    for (const listener of readlineListeners) {
      input.on("data", listener as (...args: unknown[]) => void);
    }
  };

  const finish = (value: string) => {
    if (settled) return;
    settled = true;
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = undefined;
    }
    // Leave the typed prompt on screen; erase any helper/slash UI below the cursor.
    output.write("\x1b[J\x1b[?25h\n");
    cleanup();
    resolvePrompt(restorePastes(value, pasteStash));
  };

  const abort = (reason: TuiPromptAbortReason) => {
    if (settled) return;
    settled = true;
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = undefined;
    }
    output.write("\x1b[J\x1b[?25h\n");
    cleanup();
    rejectPrompt(new TuiPromptAbortError(reason));
  };

  const insert = (value: string) => {
    if (!value) return;
    text = text.slice(0, cursor) + value + text.slice(cursor);
    cursor += value.length;
    historyIndex = history.length;
    slashSelection = clampSlashSelection(
      text,
      cursor,
      options.slashCommands ?? [],
      options.maxSlashSuggestions ?? 8,
      slashSelection
    );
  };

  const backspace = () => {
    if (cursor <= 0) return;
    const prev = previousOffset(text, cursor);
    text = text.slice(0, prev) + text.slice(cursor);
    cursor = prev;
    historyIndex = history.length;
    slashSelection = clampSlashSelection(
      text,
      cursor,
      options.slashCommands ?? [],
      options.maxSlashSuggestions ?? 8,
      slashSelection
    );
  };

  const del = () => {
    if (cursor >= text.length) return;
    const next = nextOffset(text, cursor);
    text = text.slice(0, cursor) + text.slice(next);
    historyIndex = history.length;
    slashSelection = clampSlashSelection(
      text,
      cursor,
      options.slashCommands ?? [],
      options.maxSlashSuggestions ?? 8,
      slashSelection
    );
  };

  const moveHistory = (direction: -1 | 1) => {
    if (history.length === 0) return;
    if (historyIndex === history.length) {
      draft = text;
    }
    const next = historyIndex + direction;
    if (next < 0) return;
    if (next >= history.length) {
      historyIndex = history.length;
      text = draft;
      cursor = text.length;
      slashSelection = 0;
      return;
    }
    historyIndex = next;
    text = history[historyIndex] ?? "";
    cursor = text.length;
    slashSelection = 0;
  };

  const getSlashState = () =>
    getSlashSuggestionState({
      text,
      cursor,
      commands: options.slashCommands ?? [],
      maxSuggestions: options.maxSlashSuggestions ?? 8,
      selection: slashSelection,
      final: false
    });

  const moveSlashSelection = (delta: -1 | 1): boolean => {
    const state = getSlashState();
    if (!state || state.visible.length === 0) return false;
    slashSelection = (slashSelection + delta + state.visible.length) % state.visible.length;
    return true;
  };

  const completeSlashSelection = (): boolean => {
    const state = getSlashState();
    const command = state?.visible[slashSelection];
    if (!state || !command) return false;
    text = `/${state.labels[slashSelection] ?? selectedSlashCommandName(command, state.query)}`;
    cursor = text.length;
    slashSelection = 0;
    return true;
  };

  const submitSlashSelection = (): boolean => {
    const state = getSlashState();
    const command = state?.visible[slashSelection];
    if (!state || !command) return false;
    finish(`/${state.labels[slashSelection] ?? selectedSlashCommandName(command, state.query)}`);
    return true;
  };

  const moveVerticalOrHistory = (direction: -1 | 1) => {
    const lines = splitLogicalLines(text);
    const pos = positionForOffset(lines, cursor);
    const targetLine = pos.line + direction;
    if (targetLine >= 0 && targetLine < lines.length) {
      const target = lines[targetLine]!;
      cursor = Math.min(target.start + pos.column, target.end);
      return;
    }
    moveHistory(direction);
  };

  const submit = () => {
    finish(text);
  };

  const insertNewline = () => {
    insert("\n");
  };

  const submitOrNewline = () => {
    if (cursor > 0 && text[cursor - 1] === "\\") {
      text = text.slice(0, cursor - 1) + "\n" + text.slice(cursor);
      return;
    }
    if (shouldContinueOnEnter(text, cursor)) {
      insertNewline();
      return;
    }
    finish(text);
  };

  const insertPaste = (raw: string) => {
    const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!normalized) return;
    const lineCount = normalized.split("\n").length;
    if (lineCount === 1 && normalized.length < 200) {
      insert(normalized);
      return;
    }
    pasteCounter += 1;
    const placeholder = formatPastePlaceholder(pasteCounter, normalized.length, lineCount);
    pasteStash.set(placeholder, normalized);
    insert(placeholder);
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = undefined;
    }
    render(false);
  };

  const processText = (chunk: string) => {
    let i = 0;
    while (i < chunk.length) {
      if (chunk.startsWith("\x1b[13;5u", i) || chunk.startsWith("\x1b[13;6u", i)) {
        submit();
        return;
      }
      if (
        chunk.startsWith("\x1b[13;2u", i) ||
        chunk.startsWith("\x1b[13;3u", i) ||
        chunk.startsWith("\x1b[13;4u", i)
      ) {
        insertNewline();
        i += 7;
        continue;
      }
      if (chunk.startsWith("\x1b\r", i) || chunk.startsWith("\x1b\n", i)) {
        insertNewline();
        i += 2;
        continue;
      }
      if (chunk.startsWith("\x1b[A", i)) {
        if (moveSlashSelection(-1)) {
          i += 3;
          continue;
        }
        moveVerticalOrHistory(-1);
        i += 3;
        continue;
      }
      if (chunk.startsWith("\x1b[B", i)) {
        if (moveSlashSelection(1)) {
          i += 3;
          continue;
        }
        moveVerticalOrHistory(1);
        i += 3;
        continue;
      }
      if (chunk.startsWith("\x1b[C", i)) {
        cursor = nextOffset(text, cursor);
        i += 3;
        continue;
      }
      if (chunk.startsWith("\x1b[D", i)) {
        cursor = previousOffset(text, cursor);
        i += 3;
        continue;
      }
      if (chunk.startsWith("\x1b[H", i) || chunk.startsWith("\x1b[1~", i)) {
        cursor = lineStartForOffset(text, cursor);
        i += chunk.startsWith("\x1b[H", i) ? 3 : 4;
        continue;
      }
      if (chunk.startsWith("\x1b[F", i) || chunk.startsWith("\x1b[4~", i)) {
        cursor = lineEndForOffset(text, cursor);
        i += chunk.startsWith("\x1b[F", i) ? 3 : 4;
        continue;
      }
      if (chunk.startsWith("\x1b[3~", i)) {
        del();
        i += 4;
        continue;
      }
      if (chunk[i] === "\x1b") {
        const match = chunk.slice(i).match(/^\x1b\[[0-9;?]*[~A-Za-z]/);
        if (match) {
          i += match[0].length;
          continue;
        }
        if (getSlashState()) {
          text = "";
          cursor = 0;
          slashSelection = 0;
          i += 1;
          continue;
        }
        if (text.length > 0) {
          text = "";
          cursor = 0;
          slashSelection = 0;
          i += 1;
          continue;
        }
        abort("ESC");
        return;
      }

      const ch = chunk[i]!;
      if (ch === "\x03") {
        if (text.length > 0) {
          text = "";
          cursor = 0;
        } else {
          abort("SIGINT");
          return;
        }
      } else if (ch === "\x04") {
        if (text.length === 0) {
          abort("EOF");
          return;
        }
      } else if (ch === "\n") {
        insertNewline();
      } else if (ch === "\r") {
        if (submitSlashSelection()) {
          return;
        }
        submitOrNewline();
        return;
      } else if (ch === "\x7f" || ch === "\b") {
        backspace();
      } else if (ch === "\t") {
        if (!completeSlashSelection()) {
          insert(ch);
        }
      } else if (ch >= " " || ch === "\t") {
        const grapheme = firstGrapheme(chunk.slice(i));
        insert(grapheme.segment);
        i += grapheme.segment.length - 1;
      }
      i += 1;
    }
  };

  const processPending = () => {
    while (pending.length > 0 && !settled) {
      if (pasteBuffer !== undefined) {
        const end = pending.indexOf(PASTE_END);
        if (end === -1) {
          pasteBuffer += pending;
          pending = "";
          break;
        }
        pasteBuffer += pending.slice(0, end);
        pending = pending.slice(end + PASTE_END.length);
        insertPaste(pasteBuffer);
        pasteBuffer = undefined;
        continue;
      }

      const start = pending.indexOf(PASTE_START);
      if (start === -1) {
        const chunk = pending;
        pending = "";
        processText(chunk);
        break;
      }
      if (start > 0) {
        const before = pending.slice(0, start);
        pending = pending.slice(start);
        processText(before);
        continue;
      }
      pasteBuffer = "";
      pending = pending.slice(PASTE_START.length);
    }
  };

  function scheduleRender() {
    if (renderTimer) {
      clearTimeout(renderTimer);
    }
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      if (!settled) {
        render(false);
      }
    }, 24);
  }

  function onData(buffer: Buffer) {
    pending += buffer.toString("utf8");
    processPending();
    if (!settled) scheduleRender();
  }

  function render(final: boolean) {
    const terminalColumns = output.columns || 80;
    const safeColumns = safePromptColumns(terminalColumns);
    const display = buildDisplay({
      prompt,
      text,
      cursor,
      safeColumns,
      maxVisibleLines,
      final,
      slashCommands: options.slashCommands,
      maxSlashSuggestions: options.maxSlashSuggestions,
      slashSelection
    });

    let sequence = "";
    if (renderedLines > 0) {
      sequence += clearPromptBlockSequence(renderedLines, renderedCursorLine);
    }

    sequence += display.lines.join("\n");
    renderedLines = display.lines.length;
    if (final) {
      renderedCursorLine = renderedLines - 1;
      sequence += "\x1b[?25h";
      output.write(sequence);
      return;
    }

    sequence += positionPromptCursorSequence(
      display.lines.length,
      display.cursorLine,
      display.cursorColumn,
      safeColumns
    );
    output.write(sequence);
    renderedCursorLine = display.cursorLine;
  }

  const result = new Promise<string>((resolve, reject) => {
    resolvePrompt = resolve;
    rejectPrompt = reject;
  });

  const onError = (error: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectPrompt(error);
  };

  input.on("data", onData);
  input.once("error", onError);
  render(false);

  try {
    return await result;
  } finally {
    input.off("error", onError);
  }
}

function restorePastes(value: string, pasteStash: Map<string, string>): string {
  let result = value;
  for (const [placeholder, content] of pasteStash) {
    result = result.split(placeholder).join(content);
  }
  return result;
}

function formatPastePlaceholder(counter: number, charCount: number, lineCount: number): string {
  return `${PASTE_PLACEHOLDER_PREFIX}${counter}: ${charCount} chars, ${lineCount} lines>>`;
}

export function buildPromptDisplayForTest(input: {
  prompt: string;
  text: string;
  cursor: number;
  safeColumns: number;
  maxVisibleLines: number;
  final?: boolean;
  slashCommands?: TuiPromptSlashCommand[];
  maxSlashSuggestions?: number;
  slashSelection?: number;
}): { lines: string[]; cursorLine: number; cursorColumn: number } {
  return buildDisplay({ ...input, final: input.final ?? false });
}

export function shouldContinueOnEnterForTest(text: string, cursor = text.length): boolean {
  return shouldContinueOnEnter(text, cursor);
}

function buildDisplay(input: {
  prompt: string;
  text: string;
  cursor: number;
  safeColumns: number;
  maxVisibleLines: number;
  final: boolean;
  slashCommands?: TuiPromptSlashCommand[];
  maxSlashSuggestions?: number;
  slashSelection?: number;
}): { lines: string[]; cursorLine: number; cursorColumn: number } {
  const logical = splitLogicalLines(input.text);
  const pos = positionForOffset(logical, input.cursor);
  const rows = buildDisplayRows({
    logical,
    cursorLine: pos.line,
    cursorColumn: pos.column,
    prompt: input.prompt,
    safeColumns: input.safeColumns
  });
  const cursorRow = Math.max(
    0,
    rows.findIndex((row) => row.cursorColumn !== undefined)
  );
  const half = Math.floor(input.maxVisibleLines / 2);
  let first = Math.max(0, cursorRow - half);
  const last = Math.min(rows.length, first + input.maxVisibleLines);
  first = Math.max(0, last - input.maxVisibleLines);
  const visible = rows.slice(first, last);
  const lines = visible.map((row) => row.line);
  const cursorLine = Math.max(0, cursorRow - first);
  const cursorColumn = visible[cursorLine]?.cursorColumn ?? 0;
  if (lines.length === 0) {
    lines.push(input.prompt);
  }
  const helper = promptHelperText(
    input.text,
    input.cursor,
    logical.length,
    rows.length,
    input.maxVisibleLines,
    input.final
  );
  if (helper) {
    lines.push(clipToColumns(`${DIM}${helper}${RESET}`, input.safeColumns));
  }
  lines.push(
    ...formatSlashSuggestionLines({
      text: input.text,
      cursor: input.cursor,
      commands: input.slashCommands ?? [],
      maxSuggestions: input.maxSlashSuggestions ?? 8,
      safeColumns: input.safeColumns,
      final: input.final,
      selection: input.slashSelection ?? 0
    })
  );
  return { lines, cursorLine, cursorColumn };
}

function formatSlashSuggestionLines(input: {
  text: string;
  cursor: number;
  commands: TuiPromptSlashCommand[];
  maxSuggestions: number;
  safeColumns: number;
  final: boolean;
  selection: number;
}): string[] {
  const state = getSlashSuggestionState(input);
  if (!state) {
    return [];
  }
  const header = state.query ? `commands matching /${state.query}` : "commands";
  const lines = [`${DIM}┌ ${header}${RESET}`];
  if (state.visible.length === 0) {
    lines.push(`${DIM}│ No matching commands${RESET}`);
  } else {
    const nameWidth = Math.min(
      18,
      Math.max(...state.visible.map((command) => command.name.length), 4)
    );
    for (let index = 0; index < state.visible.length; index += 1) {
      const command = state.visible[index]!;
      const labelName = state.labels[index] ?? command.name;
      const usage =
        labelName === command.name ? (command.usage ?? `/${command.name}`) : `/${labelName}`;
      const label = usage.split(/\s+/)[0] ?? `/${command.name}`;
      const padded = label.padEnd(Math.min(nameWidth + 1, 19));
      const selected = index === input.selection;
      const marker = selected ? "❯" : " ";
      const style = selected ? "\x1b[36m" : DIM;
      lines.push(`${style}│ ${marker} ${padded} ${command.description}${RESET}`);
    }
    if (state.total > state.visible.length) {
      lines.push(
        `${DIM}│ +${state.total - state.visible.length} more - keep typing to filter${RESET}`
      );
    }
  }
  lines.push(`${DIM}└ ↑↓ select · Tab complete · Enter run · Esc clear${RESET}`);
  return lines.map((line) => clipToColumns(line, input.safeColumns));
}

function getSlashSuggestionState(input: {
  text: string;
  cursor: number;
  commands: TuiPromptSlashCommand[];
  maxSuggestions: number;
  final: boolean;
  selection?: number;
}): SlashSuggestionState | undefined {
  if (input.final || input.commands.length === 0 || input.cursor !== input.text.length) {
    return undefined;
  }
  const match = input.text.match(/^\/([A-Za-z0-9_-]*)$/);
  if (!match) {
    return undefined;
  }
  const query = match[1]?.toLowerCase() ?? "";
  const candidates = query ? filterSlashCommands(input.commands, query) : [...input.commands];
  const all = candidates.sort(
    (a, b) =>
      slashSuggestionRank(a, query) - slashSuggestionRank(b, query) || a.name.localeCompare(b.name)
  );
  const visible = all.slice(0, Math.max(1, input.maxSuggestions));
  return {
    query,
    visible,
    labels: visible.map((command) => selectedSlashCommandName(command, query)),
    total: all.length
  };
}

function clampSlashSelection(
  text: string,
  cursor: number,
  commands: TuiPromptSlashCommand[],
  maxSuggestions: number,
  selection: number
): number {
  const state = getSlashSuggestionState({ text, cursor, commands, maxSuggestions, final: false });
  if (!state || state.visible.length === 0) return 0;
  return Math.min(selection, state.visible.length - 1);
}

function filterSlashCommands(
  commands: TuiPromptSlashCommand[],
  query: string
): TuiPromptSlashCommand[] {
  const prefixMatches = commands.filter(
    (command) =>
      command.name.toLowerCase().startsWith(query) ||
      (command.aliases ?? []).some((alias) => alias.toLowerCase().startsWith(query)) ||
      (command.usage ?? "").toLowerCase().replace(/^\//, "").startsWith(query)
  );
  if (prefixMatches.length > 0) {
    return prefixMatches;
  }
  return commands.filter(
    (command) =>
      command.name.toLowerCase().includes(query) ||
      (command.aliases ?? []).some((alias) => alias.toLowerCase().includes(query)) ||
      command.description.toLowerCase().includes(query) ||
      (command.usage ?? "").toLowerCase().includes(query)
  );
}

function slashSuggestionRank(command: TuiPromptSlashCommand, query: string): number {
  if (!query) return 0;
  const name = command.name.toLowerCase();
  const aliases = command.aliases ?? [];
  if (name === query) return 0;
  if (aliases.some((alias) => alias.toLowerCase() === query)) return 0;
  if (name.startsWith(query)) return 1;
  if (aliases.some((alias) => alias.toLowerCase().startsWith(query))) return 1;
  if ((command.usage ?? "").toLowerCase().includes(query)) return 2;
  if (name.includes(query)) return 3;
  if (aliases.some((alias) => alias.toLowerCase().includes(query))) return 3;
  return 4;
}

function selectedSlashCommandName(command: TuiPromptSlashCommand, query: string): string {
  const normalized = query.toLowerCase();
  if (normalized) {
    const alias = (command.aliases ?? []).find((value) =>
      value.toLowerCase().startsWith(normalized)
    );
    if (alias) {
      return alias;
    }
  }
  return command.name;
}

function buildDisplayRows(input: {
  logical: LogicalLine[];
  cursorLine: number;
  cursorColumn: number;
  prompt: string;
  safeColumns: number;
}): DisplayRow[] {
  const rows: DisplayRow[] = [];
  for (let sourceLine = 0; sourceLine < input.logical.length; sourceLine += 1) {
    const logicalLine = input.logical[sourceLine]!;
    const firstPrefix = sourceLine === 0 ? input.prompt : `${DIM}... ${RESET}`;
    const wrapPrefix = `${DIM}${" ".repeat(visibleWidth(firstPrefix))}${RESET}`;
    const firstWidth = Math.max(8, input.safeColumns - visibleWidth(firstPrefix));
    const wrapWidth = Math.max(8, input.safeColumns - visibleWidth(wrapPrefix));
    const segments = wrapTextCells(logicalLine.text, firstWidth, wrapWidth);
    const isCursorLogicalLine = sourceLine === input.cursorLine;
    const cursorCell = isCursorLogicalLine
      ? visibleWidth(logicalLine.text.slice(0, input.cursorColumn))
      : undefined;

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const prefix = index === 0 ? firstPrefix : wrapPrefix;
      const isCursorRow =
        cursorCell !== undefined &&
        cursorCell >= segment.startCell &&
        (cursorCell < segment.endCell || index === segments.length - 1);
      rows.push({
        line: clipToColumns(prefix + segment.text, input.safeColumns),
        sourceLine,
        cursorColumn: isCursorRow
          ? Math.min(
              input.safeColumns - 1,
              visibleWidth(prefix) + Math.max(0, cursorCell - segment.startCell)
            )
          : undefined
      });
    }
  }
  return rows.length > 0
    ? rows
    : [{ line: input.prompt, sourceLine: 0, cursorColumn: visibleWidth(input.prompt) }];
}

function wrapTextCells(
  text: string,
  firstWidth: number,
  nextWidth: number
): Array<{ text: string; startCell: number; endCell: number }> {
  const totalWidth = visibleWidth(text);
  if (totalWidth === 0) {
    return [{ text: "", startCell: 0, endCell: 0 }];
  }
  const segments: Array<{ text: string; startCell: number; endCell: number }> = [];
  let startCell = 0;
  let width = firstWidth;
  const maxSegments = segmentGraphemes(text).length + 2;
  while (startCell < totalWidth && segments.length < maxSegments) {
    const segment = sliceCells(text, startCell, width);
    let segmentWidth = visibleWidth(segment);
    if (segmentWidth <= 0) {
      const forced = firstGraphemeAtCell(text, startCell);
      if (!forced || forced.width <= 0) {
        break;
      }
      segments.push({
        text: forced.segment,
        startCell,
        endCell: startCell + forced.width
      });
      startCell += forced.width;
      width = nextWidth;
      continue;
    }
    const endCell = startCell + segmentWidth;
    segments.push({ text: segment, startCell, endCell });
    startCell = endCell;
    width = nextWidth;
  }
  return segments;
}

function promptHelperText(
  text: string,
  cursor: number,
  logicalLineCount: number,
  displayRowCount: number,
  maxVisibleLines: number,
  final: boolean
): string | undefined {
  if (final) return undefined;
  if (shouldContinueOnEnter(text, cursor)) {
    return "[open block: Enter adds a line, Ctrl+Enter submits]";
  }
  if (displayRowCount > maxVisibleLines) {
    return `[${displayRowCount} lines, Ctrl+J, Alt/Option+Enter, or backslash+Enter inserts a line]`;
  }
  if (logicalLineCount > 1) {
    return `[${logicalLineCount} lines, Enter submits, Ctrl+J or Alt/Option+Enter inserts a line]`;
  }
  return undefined;
}

function shouldContinueOnEnter(text: string, cursor: number): boolean {
  if (cursor !== text.length || text.length === 0) {
    return false;
  }
  const withoutPastePlaceholders = text.replace(/<<paste #\d+: [^>]+>>/g, "");
  const before = withoutPastePlaceholders.slice(0, cursor);
  return hasUnclosedMarkdownFence(before) || hasUnclosedBracket(before);
}

function hasUnclosedMarkdownFence(text: string): boolean {
  const fences = text.split("\n").filter((line) => line.trimStart().startsWith("```"));
  return fences.length % 2 !== 0;
}

function hasUnclosedBracket(text: string): boolean {
  const stack: string[] = [];
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      stack.push(char);
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      const open = stack.at(-1);
      if (
        (open === "(" && char === ")") ||
        (open === "[" && char === "]") ||
        (open === "{" && char === "}")
      ) {
        stack.pop();
      }
    }
  }
  return stack.length > 0;
}

function splitLogicalLines(text: string): LogicalLine[] {
  const lines: LogicalLine[] = [];
  let start = 0;
  for (let index = 0; index <= text.length; index++) {
    if (index === text.length || text[index] === "\n") {
      lines.push({ text: text.slice(start, index), start, end: index });
      start = index + 1;
    }
  }
  return lines.length > 0 ? lines : [{ text: "", start: 0, end: 0 }];
}

function positionForOffset(lines: LogicalLine[], offset: number): { line: number; column: number } {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (offset >= line.start && offset <= line.end) {
      return { line: index, column: offset - line.start };
    }
  }
  const last = lines[lines.length - 1]!;
  return { line: lines.length - 1, column: last.text.length };
}

function windowStartForCursor(column: number, width: number, lineLength: number): number {
  if (lineLength <= width) return 0;
  const margin = Math.max(2, Math.floor(width / 4));
  if (column < width - margin) return 0;
  return Math.min(lineLength - width, column - width + margin);
}

function previousOffset(text: string, offset: number): number {
  if (offset <= 0) return 0;
  let previous = 0;
  for (const grapheme of segmentGraphemes(text)) {
    if (grapheme.index >= offset) {
      return previous;
    }
    previous = grapheme.index;
  }
  return previous;
}

function nextOffset(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  for (const grapheme of segmentGraphemes(text)) {
    if (grapheme.index > offset) {
      return grapheme.index;
    }
  }
  return text.length;
}

function lineStartForOffset(text: string, offset: number): number {
  const prev = text.lastIndexOf("\n", Math.max(0, offset - 1));
  return prev === -1 ? 0 : prev + 1;
}

function lineEndForOffset(text: string, offset: number): number {
  const next = text.indexOf("\n", offset);
  return next === -1 ? text.length : next;
}

function clipToColumns(text: string, columns: number): string {
  let result = "";
  let width = 0;
  let ansi = false;
  for (const ch of Array.from(text)) {
    if (ch === "\x1b") ansi = true;
    result += ch;
    if (ansi) {
      if (ch === "m") ansi = false;
      continue;
    }
    const next = width + charWidth(ch);
    if (next > columns) {
      return result.slice(0, -ch.length) + RESET;
    }
    width = next;
    if (width >= columns) {
      return result + RESET;
    }
  }
  return result;
}

function visibleWidth(text: string): number {
  return segmentGraphemes(stripAnsi(text)).reduce((sum, grapheme) => sum + grapheme.width, 0);
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*m/g, "");
}

function charWidth(ch: string): number {
  if (!ch) return 0;
  let width = 0;
  for (const grapheme of segmentGraphemes(ch)) {
    width += grapheme.width;
  }
  return width;
}

function sliceCells(text: string, startCell: number, width: number): string {
  let result = "";
  let cell = 0;
  for (const grapheme of segmentGraphemes(text)) {
    const graphemeStart = cell;
    const graphemeEnd = cell + grapheme.width;
    if (graphemeEnd <= startCell) {
      cell = graphemeEnd;
      continue;
    }
    if (graphemeStart >= startCell + width) {
      break;
    }
    if (graphemeStart >= startCell && graphemeEnd <= startCell + width) {
      result += grapheme.segment;
    }
    cell = graphemeEnd;
    if (cell >= startCell + width) {
      break;
    }
  }
  return result;
}

function firstGraphemeAtCell(
  text: string,
  startCell: number
): { segment: string; width: number } | undefined {
  let cell = 0;
  for (const grapheme of segmentGraphemes(text)) {
    if (cell + grapheme.width > startCell) {
      return { segment: grapheme.segment, width: grapheme.width };
    }
    cell += grapheme.width;
  }
  return undefined;
}

function firstGrapheme(text: string): Grapheme {
  return segmentGraphemes(text)[0] ?? { segment: text[0] ?? "", index: 0, width: text[0] ? 1 : 0 };
}

function segmentGraphemes(text: string): Grapheme[] {
  const segmenter = getGraphemeSegmenter();
  const segments = segmenter
    ? [...segmenter.segment(text)].map(({ segment, index }) => ({
        segment,
        index,
        width: graphemeWidth(segment)
      }))
    : Array.from(text).map((segment, index) => ({ segment, index, width: graphemeWidth(segment) }));
  return segments;
}

function getGraphemeSegmenter(): Intl.Segmenter | undefined {
  if (graphemeSegmenter) {
    return graphemeSegmenter;
  }
  if (typeof Intl.Segmenter !== "function") {
    return undefined;
  }
  graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return graphemeSegmenter;
}

function graphemeWidth(grapheme: string): number {
  if (!grapheme) return 0;
  if (isEmojiGrapheme(grapheme)) {
    return isSingleRegionalIndicator(grapheme) ? 1 : 2;
  }
  for (const char of grapheme) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && !isZeroWidth(codePoint)) {
      return codePointWidth(codePoint);
    }
  }
  return 0;
}

function codePointWidth(codePoint: number): number {
  return isWideCodePoint(codePoint) ? 2 : 1;
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff))
  );
}

function isEmojiGrapheme(grapheme: string): boolean {
  for (const char of grapheme) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    if (
      (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
      (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
      codePoint === 0xfe0f ||
      codePoint === 0x200d
    ) {
      return true;
    }
  }
  return false;
}

function isSingleRegionalIndicator(grapheme: string): boolean {
  const chars = Array.from(grapheme);
  const codePoint = chars[0]?.codePointAt(0);
  return (
    chars.length === 1 && codePoint !== undefined && codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff
  );
}

function isZeroWidth(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    codePoint === 0xfeff ||
    codePoint === 0x00ad
  );
}

function safePromptColumns(terminalColumns: number): number {
  return Math.max(20, terminalColumns - 6);
}

function clampCursorEscapeCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(Math.floor(value), 9999);
}

function clearPromptBlockSequence(lineCount: number, cursorLine: number): string {
  if (lineCount <= 0) {
    return "";
  }
  let sequence = "\x1b[?25l";
  const upToFirst = clampCursorEscapeCount(cursorLine);
  if (upToFirst > 0) {
    sequence += `\x1b[${upToFirst}A`;
  }
  // Erase the prior prompt block in one pass. Avoid per-line `\x1b[1B`, which
  // can scroll Terminal.app at the bottom edge and crash during fast redraws.
  sequence += "\r\x1b[2K\x1b[J";
  return sequence;
}

function positionPromptCursorSequence(
  totalLines: number,
  cursorLine: number,
  cursorColumn: number,
  maxColumn: number
): string {
  const up = clampCursorEscapeCount(totalLines - 1 - cursorLine);
  const col = Math.max(0, Math.min(Math.floor(cursorColumn) || 0, maxColumn - 1));
  let sequence = "";
  if (up > 0) {
    sequence += `\x1b[${up}A`;
  }
  sequence += `\x1b[${col + 1}G\x1b[?25h`;
  return sequence;
}

function clearPromptBlock(output: NodeJS.WriteStream, lineCount: number, cursorLine: number): void {
  output.write(clearPromptBlockSequence(lineCount, cursorLine));
}

function positionPromptCursor(
  output: NodeJS.WriteStream,
  totalLines: number,
  cursorLine: number,
  cursorColumn: number,
  maxColumn: number
): void {
  output.write(positionPromptCursorSequence(totalLines, cursorLine, cursorColumn, maxColumn));
}
