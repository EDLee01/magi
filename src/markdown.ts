/**
 * Streaming markdown renderer for terminal output.
 * Buffers code blocks, renders inline markdown immediately.
 */

import { stdout } from "node:process";
import { createHighlightState, highlightLine, HighlightState } from "./syntax-highlight.js";

// ANSI codes
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";
const STRIKETHROUGH = "\x1b[9m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GRAY = "\x1b[90m";
const BG_GRAY = "\x1b[48;5;236m";
const WHITE = "\x1b[37m";

export interface StreamingMarkdownRenderer {
  /** Push a text delta. Returns ANSI string to write to terminal. */
  push(delta: string): string;
  /** Flush any remaining buffered content. Returns ANSI string. */
  flush(): string;
}

export interface MarkdownOptions {
  /** Total terminal columns. Defaults to stdout.columns or 80. */
  columns?: number;
  /** Disable syntax highlighting (e.g. for non-color terminals). */
  noHighlight?: boolean;
}

function getColumns(options?: MarkdownOptions): number {
  if (options?.columns && options.columns > 20) return Math.min(options.columns, 200);
  const c = stdout.columns;
  if (typeof c === "number" && c > 20) return Math.min(c, 200);
  return 80;
}

export function createStreamingMarkdown(options?: MarkdownOptions): StreamingMarkdownRenderer {
  const cols = getColumns(options);
  const innerWidth = Math.max(20, cols - 4);
  const highlight = !options?.noHighlight;
  let buffer = "";
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeBlockContent: string[] = [];
  let highlightState: HighlightState = createHighlightState();
  // Pending table rows being collected. Format: [header, separator, ...body]
  let tableRows: string[] = [];

  return { push, flush };

  function push(delta: string): string {
    buffer += delta;
    const outParts: string[] = [];
    let bufOffset = 0;

    while (true) {
      const nlIdx = buffer.indexOf("\n", bufOffset);
      if (nlIdx === -1) break;
      const line = buffer.substring(bufOffset, nlIdx);
      bufOffset = nlIdx + 1;
      const processed = processLine(line);
      // Suppress newline for empty processed output (e.g. table rows being collected)
      outParts.push(processed + (processed === "" ? "" : "\n"));
    }

    // Compact buffer: drop consumed prefix, force fresh allocation to break
    // V8's retained-string chain (sliced strings keep parent alive → unbounded growth → OOM).
    if (bufOffset > 0) {
      buffer =
        bufOffset === buffer.length
          ? ""
          : Buffer.from(buffer.substring(bufOffset), "utf8").toString("utf8");
    }
    // Hard cap: if a single line ever exceeds 1MB without newline, drop the buffer
    // rather than letting downstream regex.replace OOM.
    if (buffer.length > 1024 * 1024) {
      buffer = "";
    }

    return outParts.join("");
  }

  function flush(): string {
    let out = "";
    if (tableRows.length > 0) {
      out += renderTable(tableRows, innerWidth);
      tableRows = [];
    }
    if (buffer) {
      if (inCodeBlock) {
        // Stream the trailing partial line, then close the block
        const highlighted = highlight
          ? highlightLine(buffer, codeBlockLang, highlightState)
          : buffer;
        out += `${GRAY}│${RESET} ${highlighted}\n`;
        out += `${GRAY}╰${"─".repeat(innerWidth + 2)}╯${RESET}`;
        inCodeBlock = false;
        codeBlockContent = [];
        highlightState = createHighlightState();
      } else {
        out += renderInlineLine(buffer);
      }
      buffer = "";
    } else if (inCodeBlock) {
      // Close any unfinished code block (lines already emitted)
      out += `${GRAY}╰${"─".repeat(innerWidth + 2)}╯${RESET}`;
      inCodeBlock = false;
      codeBlockContent = [];
      highlightState = createHighlightState();
    }
    return out;
  }

  function processLine(line: string): string {
    // Code fence
    if (line.startsWith("```")) {
      // Flush any pending table before entering a code block
      let prefix = "";
      if (tableRows.length > 0) {
        prefix = renderTable(tableRows, innerWidth);
        tableRows = [];
      }
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
        codeBlockContent = [];
        highlightState = createHighlightState();
        const langLabel = codeBlockLang ? ` ${codeBlockLang} ` : "";
        const dashCount = Math.max(0, innerWidth - langLabel.length);
        return `${prefix}${GRAY}╭─${langLabel}${"─".repeat(dashCount)}╮${RESET}`;
      } else {
        // Close fence: just emit the bottom border (lines were streamed already)
        inCodeBlock = false;
        codeBlockContent = [];
        highlightState = createHighlightState();
        return `${prefix}${GRAY}╰${"─".repeat(innerWidth + 2)}╯${RESET}`;
      }
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      const highlighted = highlight ? highlightLine(line, codeBlockLang, highlightState) : line;
      return `${GRAY}│${RESET} ${highlighted}`;
    }

    // Tables: pipe-delimited rows. We collect until we see a non-table line.
    if (isTableRow(line)) {
      tableRows.push(line);
      return "";
    } else if (tableRows.length > 0) {
      const tableOut = renderTable(tableRows, innerWidth);
      tableRows = [];
      return tableOut + (line.length > 0 ? "\n" + renderInlineLine(line) : "");
    }

    return renderInlineLine(line);
  }
}

function renderCodeBlockBody(
  lines: string[],
  lang: string,
  innerWidth: number,
  highlight: boolean
): string {
  const state = createHighlightState();
  return lines
    .map((l) => {
      const rendered = highlight ? highlightLine(l, lang, state) : l;
      return `${GRAY}│${RESET} ${rendered}`;
    })
    .join("\n");
}

function isTableRow(line: string): boolean {
  // A markdown table row starts and ends with optional spaces around |
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.includes("|", 1)) return false;
  return true;
}

function renderTable(rows: string[], innerWidth: number): string {
  if (rows.length === 0) return "";
  // Parse: each row "| a | b | c |"
  const parsed = rows.map(parseTableRow);
  // Detect separator row (---)
  const hasSep = parsed.length >= 2 && parsed[1].every((c) => /^:?-+:?$/.test(c.trim()));
  const header = parsed[0];
  const body = hasSep ? parsed.slice(2) : parsed.slice(1);
  const colCount = header.length;

  // Compute column widths
  const widths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    let w = stripAnsi(header[c]).length;
    for (const r of body) {
      if (r[c]) w = Math.max(w, stripAnsi(r[c]).length);
    }
    widths.push(Math.max(3, w));
  }
  // Cap total width to innerWidth
  const totalContent = widths.reduce((s, w) => s + w, 0);
  const padding = colCount * 3 + 1;
  const overflow = totalContent + padding - innerWidth;
  if (overflow > 0) {
    // Shrink the widest columns proportionally
    const sortable = widths.map((w, i) => ({ w, i })).sort((a, b) => b.w - a.w);
    let remaining = overflow;
    for (const item of sortable) {
      if (remaining <= 0) break;
      const cut = Math.min(item.w - 3, remaining);
      widths[item.i] -= cut;
      remaining -= cut;
    }
  }

  const lines: string[] = [];
  const sep = `${GRAY}+${widths.map((w) => "-".repeat(w + 2)).join("+")}+${RESET}`;
  lines.push(sep);
  lines.push(rowToLine(header, widths, true));
  lines.push(sep);
  for (const r of body) {
    lines.push(rowToLine(r, widths, false));
  }
  lines.push(sep);
  return lines.join("\n");
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim();
  // Strip leading/trailing |
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((s) => s.trim());
}

function rowToLine(cells: string[], widths: number[], isHeader: boolean): string {
  const segments = widths.map((w, i) => {
    const cell = cells[i] ?? "";
    const truncated = truncate(cell, w);
    const padded = truncated + " ".repeat(Math.max(0, w - stripAnsi(truncated).length));
    const inline = renderInline(padded);
    return ` ${isHeader ? BOLD + inline + RESET : inline} `;
  });
  return `${GRAY}|${RESET}${segments.join(`${GRAY}|${RESET}`)}${GRAY}|${RESET}`;
}

function truncate(text: string, w: number): string {
  const len = stripAnsi(text).length;
  if (len <= w) return text;
  return text.slice(0, Math.max(0, w - 1)) + "…";
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderInlineLine(line: string): string {
  // Headers
  const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
  if (headerMatch) {
    const level = headerMatch[1].length;
    const text = renderInline(headerMatch[2]);
    if (level === 1) return `\n${BOLD}${CYAN}${text}${RESET}\n`;
    if (level === 2) return `\n${BOLD}${text}${RESET}\n`;
    if (level === 3) return `${BOLD}${text}${RESET}`;
    return `${DIM}${BOLD}${text}${RESET}`;
  }

  // Horizontal rule
  if (/^[-*_]{3,}\s*$/.test(line)) {
    const cols = getColumns();
    return `${GRAY}${"─".repeat(Math.min(cols, 80))}${RESET}`;
  }

  // Blockquote
  if (line.startsWith("> ")) {
    return `${GRAY}│${RESET} ${DIM}${renderInline(line.slice(2))}${RESET}`;
  }

  // Unordered list
  const ulMatch = line.match(/^(\s*)[*\-+]\s+(.+)$/);
  if (ulMatch) {
    const indent = ulMatch[1];
    return `${indent}${GRAY}•${RESET} ${renderInline(ulMatch[2])}`;
  }

  // Ordered list
  const olMatch = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
  if (olMatch) {
    const indent = olMatch[1];
    return `${indent}${GRAY}${olMatch[2]}.${RESET} ${renderInline(olMatch[3])}`;
  }

  return renderInline(line);
}

function renderInline(text: string): string {
  // Inline code
  text = text.replace(/`([^`]+)`/g, `${BG_GRAY}${WHITE} $1 ${RESET}`);

  // Bold + italic
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, `${BOLD}${ITALIC}$1${RESET}`);

  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`);
  text = text.replace(/__(.+?)__/g, `${BOLD}$1${RESET}`);

  // Italic
  text = text.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, `${ITALIC}$1${RESET}`);
  text = text.replace(/(?<!_)_([^_]+?)_(?!_)/g, `${ITALIC}$1${RESET}`);

  // Strikethrough
  text = text.replace(/~~(.+?)~~/g, `${STRIKETHROUGH}$1${RESET}`);

  // Links [text](url)
  text = text.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    `${UNDERLINE}${CYAN}$1${RESET}${GRAY} ($2)${RESET}`
  );

  return text;
}

export function renderCodeBlock(lines: string[], lang: string, options?: MarkdownOptions): string {
  const cols = getColumns(options);
  const innerWidth = Math.max(20, cols - 4);
  const highlight = !options?.noHighlight;
  const langLabel = lang ? ` ${lang} ` : "";
  const dashCount = Math.max(0, innerWidth - langLabel.length);
  const header = `${GRAY}╭─${langLabel}${"─".repeat(dashCount)}╮${RESET}`;
  const footer = `${GRAY}╰${"─".repeat(innerWidth + 2)}╯${RESET}`;
  const body = renderCodeBlockBody(lines, lang, innerWidth, highlight);
  return `${header}\n${body}\n${footer}`;
}
