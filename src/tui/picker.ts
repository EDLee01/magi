import { Readable, Writable } from "node:stream";

export interface TuiPickerItem {
  label: string;
  value: string;
  description?: string;
  detail?: string;
  disabled?: boolean;
}

export interface TuiPickerOptions {
  stdin: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => void; isRaw?: boolean };
  stdout: Pick<Writable, "write"> & { columns?: number };
  title: string;
  items: TuiPickerItem[];
  emptyMessage?: string;
  footer?: string;
  initialFilter?: string;
  labelPrefix?: string;
  queryPrefix?: string;
  maxVisibleItems?: number;
  width?: number;
  allowCustomValue?: (filter: string) => string | undefined;
  hotkeys?: Record<string, string>;
  cancelValue?: string;
  signal?: AbortSignal;
}

const RESET = "\x1b[0m";
const DIM = "\x1b[90m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";

export async function showTuiPicker(options: TuiPickerOptions): Promise<string | undefined> {
  const { stdin, stdout } = options;
  const maxVisibleItems = Math.max(1, options.maxVisibleItems ?? 10);
  const terminalWidth = options.width ?? stdout.columns ?? 80;
  const width = Math.max(40, terminalWidth - 2);
  const labelPrefix = options.labelPrefix ?? "";
  const queryPrefix = options.queryPrefix ?? labelPrefix;
  let filter = options.initialFilter ?? "";
  let filtered = filterPickerItems(options.items, filter);
  let selected = firstSelectableIndex(filtered);
  let scrollOffset = 0;
  let lastRenderedLines = 0;

  const render = () => {
    clearPrevious();
    const visibleCount = Math.min(maxVisibleItems, filtered.length);
    const maxLabel = Math.min(
      24,
      Math.max(4, ...filtered.map((item) => inlineText(item.label).length))
    );
    const lines: string[] = [];
    const title = inlineText(options.title);
    const visibleFilter = inlineText(filter);
    const visibleEmpty = inlineText(options.emptyMessage ?? "No matching items");
    const visibleFooter = inlineText(
      options.footer ?? "↑↓ select · Tab complete · Enter choose · Esc cancel"
    );

    lines.push(
      clip(
        `${DIM}┌ ${title}${visibleFilter ? ` matching ${queryPrefix}${visibleFilter}` : ""}${RESET}`,
        width
      )
    );
    lines.push(
      clip(
        `> ${CYAN}${queryPrefix}${visibleFilter}${RESET}${visibleFilter ? "" : `${DIM} type to filter${RESET}`}`,
        width
      )
    );

    if (filtered.length === 0) {
      lines.push(clip(`${DIM}│ ${visibleEmpty}${RESET}`, width));
    } else {
      for (let index = 0; index < visibleCount; index += 1) {
        const itemIndex = scrollOffset + index;
        const item = filtered[itemIndex]!;
        const isSelected = itemIndex === selected;
        const marker = isSelected ? "❯" : " ";
        const labelText = `${labelPrefix}${inlineText(item.label)}`;
        const labelWidth = Math.min(maxLabel + labelPrefix.length + 1, 26);
        const description = item.description ? ` ${inlineText(item.description)}` : "";
        const detail = item.detail ? ` ${DIM}${inlineText(item.detail)}${RESET}` : "";
        const style = item.disabled ? DIM : isSelected ? CYAN : DIM;
        const scroll =
          filtered.length > maxVisibleItems
            ? ` ${DIM}${itemIndex + 1}/${filtered.length}${RESET}${style}`
            : "";
        const label = scroll ? fitInlineText(labelText, labelWidth) : labelText.padEnd(labelWidth);
        const emphasisStart = isSelected && !item.disabled ? BOLD : "";
        const emphasisEnd = isSelected && !item.disabled ? BOLD_OFF : "";
        lines.push(
          clip(
            `${style}│ ${marker} ${emphasisStart}${label}${emphasisEnd}${scroll}${description}${detail}${RESET}`,
            width
          )
        );
      }
    }

    lines.push(clip(`${DIM}└ ${visibleFooter}${RESET}`, width));
    stdout.write(`${lines.join("\n")}\n`);
    lastRenderedLines = lines.length;
  };

  const clearPrevious = () => {
    if (lastRenderedLines <= 0) return;
    stdout.write(`\x1b[${lastRenderedLines}A`);
    for (let index = 0; index < lastRenderedLines; index += 1) {
      stdout.write("\x1b[2K\n");
    }
    stdout.write(`\x1b[${lastRenderedLines}A`);
  };

  const clear = () => {
    clearPrevious();
    stdout.write("\x1b[2K\x1b[?25h");
    lastRenderedLines = 0;
  };

  const applyFilter = () => {
    filtered = filterPickerItems(options.items, filter);
    selected = firstSelectableIndex(filtered);
    scrollOffset = 0;
  };

  const move = (delta: number) => {
    if (filtered.length === 0 || selected < 0) return;
    let next = selected;
    for (let attempts = 0; attempts < filtered.length; attempts += 1) {
      next = (next + delta + filtered.length) % filtered.length;
      if (!filtered[next]?.disabled) {
        selected = next;
        break;
      }
    }
    if (selected < scrollOffset) scrollOffset = selected;
    if (selected >= scrollOffset + maxVisibleItems) scrollOffset = selected - maxVisibleItems + 1;
  };

  const complete = () => {
    const item = filtered[selected];
    if (!item || item.disabled) return;
    filter = inlineText(item.label);
    applyFilter();
  };

  const choose = (): string | undefined => {
    const item = filtered[selected];
    if (item && !item.disabled) {
      return item.value;
    }
    return filter ? options.allowCustomValue?.(filter) : undefined;
  };

  const wasRaw = stdin.isRaw;
  const wasPaused = stdin.isPaused();
  stdout.write("\x1b[?25l");
  if (stdin.setRawMode) stdin.setRawMode(true);
  stdin.resume();
  render();

  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    const cleanup = () => {
      options.signal?.removeEventListener("abort", onAbort);
      stdin.removeListener("data", onData);
      if (stdin.setRawMode) stdin.setRawMode(Boolean(wasRaw));
      if (wasPaused) stdin.pause();
      clear();
    };

    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const onAbort = () => finish(options.cancelValue);

    const processChunk = (chunk: string) => {
      let index = 0;
      while (index < chunk.length) {
        if (chunk.startsWith("\x1b[A", index)) {
          move(-1);
          render();
          index += 3;
          continue;
        }
        if (chunk.startsWith("\x1b[B", index)) {
          move(1);
          render();
          index += 3;
          continue;
        }
        if (chunk.startsWith("\x1b[5~", index)) {
          move(-maxVisibleItems);
          render();
          index += 4;
          continue;
        }
        if (chunk.startsWith("\x1b[6~", index)) {
          move(maxVisibleItems);
          render();
          index += 4;
          continue;
        }

        const char = chunk[index]!;
        if (char === "\x1b" || char === "\x03") {
          finish(options.cancelValue);
          return;
        }
        if (char === "\r" || char === "\n") {
          finish(choose());
          return;
        }
        const hotkeyValue = options.hotkeys?.[char];
        if (hotkeyValue !== undefined) {
          finish(hotkeyValue);
          return;
        }
        if (char === "\t") {
          complete();
          render();
          index += 1;
          continue;
        }
        if (char === "\x7f" || char === "\b") {
          if (filter.length === 0) {
            finish(undefined);
            return;
          }
          filter = filter.slice(0, -1);
          applyFilter();
          render();
          index += 1;
          continue;
        }
        if (char === "\x15") {
          filter = "";
          applyFilter();
          render();
          index += 1;
          continue;
        }
        if (char >= " " && char !== "\x7f") {
          filter += char;
          applyFilter();
          render();
        }
        index += 1;
      }
    };

    function onData(buffer: Buffer | string) {
      processChunk(Buffer.isBuffer(buffer) ? buffer.toString("utf8") : buffer);
    }

    if (options.signal?.aborted) {
      finish(options.cancelValue);
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    stdin.on("data", onData);
  });
}

function filterPickerItems(items: TuiPickerItem[], filter: string): TuiPickerItem[] {
  const query = inlineText(filter).toLowerCase();
  if (!query) {
    return [...items];
  }
  const candidates = items.filter(
    (item) =>
      inlineText(item.label).toLowerCase().includes(query) ||
      inlineText(item.description ?? "")
        .toLowerCase()
        .includes(query) ||
      inlineText(item.detail ?? "")
        .toLowerCase()
        .includes(query)
  );
  return [...candidates].sort(
    (a, b) => rankPickerItem(a, query) - rankPickerItem(b, query) || a.label.localeCompare(b.label)
  );
}

function rankPickerItem(item: TuiPickerItem, query: string): number {
  if (!query) return item.disabled ? 10 : 0;
  const label = inlineText(item.label).toLowerCase();
  if (label === query) return 0;
  if (label.startsWith(query)) return 1;
  if (
    inlineText(item.description ?? "")
      .toLowerCase()
      .includes(query)
  )
    return 2;
  if (label.includes(query)) return 3;
  return 4;
}

function inlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function fitInlineText(text: string, width: number): string {
  const clean = inlineText(text);
  if (cellWidth(clean) <= width) return clean.padEnd(width);
  let result = "";
  let used = 0;
  for (const char of clean) {
    const next = used + charWidth(char);
    if (next > width - 1) break;
    result += char;
    used = next;
  }
  return `${result}…`.padEnd(width);
}

function firstSelectableIndex(items: TuiPickerItem[]): number {
  const index = items.findIndex((item) => !item.disabled);
  return index === -1 ? 0 : index;
}

function clip(text: string, width: number): string {
  const clean = stripAnsi(text);
  if (cellWidth(clean) <= width) return text;
  let result = "";
  let used = 0;
  for (const char of clean) {
    const next = used + charWidth(char);
    if (next > width - 1) return `${result}…`;
    result += char;
    used = next;
  }
  return result;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
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
