import { TuiBlock, TuiPendingBlock, TuiRenderState } from "./render-state.js";

export interface TuiRenderOptions {
  width?: number;
  color?: boolean;
  showTimestamps?: boolean;
  maxBlocks?: number;
}

const RESET = "\x1b[0m";
const DIM = "\x1b[90m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";

export function renderTuiState(state: TuiRenderState, options: TuiRenderOptions = {}): string {
  const width = Math.max(40, options.width ?? 100);
  const maxBlocks = options.maxBlocks ?? state.blocks.length;
  const blocks = state.blocks.slice(Math.max(0, state.blocks.length - maxBlocks));
  const lines: string[] = [];
  lines.push(renderHeader(state, width, options));
  lines.push(renderSummary(state, width, options));
  lines.push(renderPending(state.pending, width, options));
  if (blocks.length === 0) {
    lines.push(colorize("No transcript activity yet.", DIM, options));
  } else {
    for (const block of blocks) {
      lines.push(...renderBlock(block, width, options));
    }
  }
  return lines.join("\n");
}

export function renderTuiBlock(block: TuiBlock, options: TuiRenderOptions = {}): string {
  return renderBlock(block, Math.max(40, options.width ?? 100), options).join("\n");
}

export function renderTuiPendingBlock(
  block: TuiPendingBlock,
  options: TuiRenderOptions = {}
): string {
  const prefix = block.kind === "question" ? "?" : "!";
  const title = `${prefix} ${block.title}`;
  const detail = block.detail ? ` - ${block.detail}` : "";
  return clip(`${title}${detail}`, Math.max(40, options.width ?? 100));
}

function renderHeader(state: TuiRenderState, width: number, options: TuiRenderOptions): string {
  const parts = [
    "Magi",
    state.model ? `model ${state.model}` : undefined,
    state.sessionId ? `session ${shortId(state.sessionId)}` : "session none",
    state.cwd
  ].filter((part): part is string => Boolean(part));
  return colorize(clip(parts.join(" · "), width), CYAN, options);
}

function renderSummary(state: TuiRenderState, width: number, options: TuiRenderOptions): string {
  const summary = [
    `${state.summary.visibleEvents} visible`,
    `${state.summary.pending} pending`,
    `${state.summary.completed} completed`,
    `${state.summary.failed} failed`
  ].join(" · ");
  return colorize(clip(summary, width), DIM, options);
}

function renderPending(
  blocks: TuiPendingBlock[],
  width: number,
  options: TuiRenderOptions
): string {
  if (blocks.length === 0) {
    return colorize("Pending: none", DIM, options);
  }
  return [
    colorize(`Pending: ${blocks.length}`, YELLOW, options),
    ...blocks.map((block) =>
      colorize(
        `  ${renderTuiPendingBlock(block, { ...options, width: width - 2 })}`,
        YELLOW,
        options
      )
    )
  ].join("\n");
}

function renderBlock(block: TuiBlock, width: number, options: TuiRenderOptions): string[] {
  const marker = markerForBlock(block);
  const title = `${marker} ${block.title}`;
  const detail = block.detail ? ` - ${block.detail}` : "";
  const time = options.showTimestamps && block.timestamp ? `${block.timestamp} ` : "";
  const first = `${time}${title}${detail}`;
  return [colorize(clip(first, width), colorForBlock(block), options)];
}

function markerForBlock(block: TuiBlock): string {
  if (block.status === "pending") return "…";
  if (block.status === "failed" || block.status === "denied") return "✗";
  if (block.status === "cancelled") return "⊘";
  if (block.status === "timeout") return "!";
  if (block.status === "completed" || block.status === "resolved" || block.status === "answered")
    return "✓";
  switch (block.kind) {
    case "approval":
    case "question":
      return "?";
    case "tool":
    case "git":
      return "•";
    default:
      return "·";
  }
}

function colorForBlock(block: TuiBlock): string {
  switch (block.kind) {
    case "approval":
    case "question":
      return YELLOW;
    case "tool":
      return CYAN;
    case "git":
      return MAGENTA;
    case "memory":
    case "todo":
      return GREEN;
    case "fallback":
      return RED;
    case "query":
      return BLUE;
    default:
      return DIM;
  }
}

function colorize(text: string, color: string, options: TuiRenderOptions): string {
  if (options.color === false) return stripAnsi(text);
  return `${color}${text}${RESET}`;
}

function clip(text: string, width: number): string {
  const clean = stripAnsi(text);
  if (cellWidth(clean) <= width) return text;
  let out = "";
  let used = 0;
  for (const char of clean) {
    const next = used + charWidth(char);
    if (next > width - 1) {
      return `${out}…`;
    }
    out += char;
    used = next;
  }
  return out;
}

function cellWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char);
  return width;
}

function charWidth(char: string): number {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return 0;
  return codePoint >= 0x1100 &&
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
    ? 2
    : 1;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*m/g, "");
}

function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…`;
}
