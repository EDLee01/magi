import { Readable, Writable } from "node:stream";

export interface SlashMenuItem {
  name: string;
  description: string;
}

const WINDOW = 10; // max visible items

export async function showSlashMenu(input: {
  stdin: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => void; isRaw?: boolean };
  stdout: Pick<Writable, "write">;
  items: SlashMenuItem[];
}): Promise<string | undefined> {
  const { stdin, stdout, items } = input;
  if (items.length === 0) return undefined;

  let filter = "";
  let filtered = items;
  let selected = 0;
  let scrollOffset = 0;
  let lastRenderedLines = 0;

  function getVisibleCount() {
    return Math.min(WINDOW, filtered.length);
  }

  function getMaxName() {
    return filtered.length > 0 ? Math.max(...filtered.map(i => i.name.length)) : 8;
  }

  function applyFilter() {
    const q = filter.toLowerCase();
    filtered = q
      ? items.filter(i => i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q))
      : items;
    selected = 0;
    scrollOffset = 0;
  }

  function render() {
    const visibleCount = getVisibleCount();
    const maxName = getMaxName();

    // Clear previous render by moving up and erasing each line
    if (lastRenderedLines > 0) {
      stdout.write(`\x1b[${lastRenderedLines}A`);
      for (let i = 0; i < lastRenderedLines; i++) {
        stdout.write(`\x1b[2K\n`);
      }
      stdout.write(`\x1b[${lastRenderedLines}A`);
    }

    const lines: string[] = [];

    // Input line showing what user typed
    lines.push(`\x1b[2K> \x1b[36m/${filter}\x1b[39m\x1b[90m${filter ? "" : " type to filter"}\x1b[39m`);

    // Filtered items
    if (filtered.length === 0) {
      lines.push(`\x1b[2K  \x1b[90mNo matching commands\x1b[39m`);
    } else {
      for (let i = 0; i < visibleCount; i++) {
        const idx = scrollOffset + i;
        const item = filtered[idx];
        const isSel = idx === selected;
        const prefix = isSel ? "\x1b[36m❯\x1b[39m" : " ";
        const name = isSel
          ? `\x1b[1m/${item.name.padEnd(maxName)}\x1b[22m`
          : `\x1b[90m/${item.name.padEnd(maxName)}\x1b[39m`;
        const desc = `\x1b[90m${item.description}\x1b[39m`;
        const scroll = filtered.length > WINDOW ? ` \x1b[90m${idx + 1}/${filtered.length}\x1b[39m` : "";
        lines.push(`\x1b[2K${prefix} ${name}  ${desc}${scroll}`);
      }
    }

    // Hint line
    lines.push(`\x1b[2K\x1b[90m  ↑↓ navigate · enter select · esc cancel · type to filter\x1b[39m`);

    // Each line ends with \n so cursor ends up below the menu
    stdout.write(lines.map(l => l + "\n").join(""));
    lastRenderedLines = lines.length;
  }

  function clear() {
    if (lastRenderedLines > 0) {
      stdout.write(`\x1b[${lastRenderedLines}A`);
      for (let i = 0; i < lastRenderedLines; i++) {
        stdout.write(`\x1b[2K\n`);
      }
      stdout.write(`\x1b[${lastRenderedLines}A\x1b[2K`);
    }
    stdout.write(`\x1b[?25h`);
  }

  // Hide cursor, then do first render (no extra newline needed)
  stdout.write(`\x1b[?25l`);
  lastRenderedLines = 0;
  render();

  return new Promise<string | undefined>((resolve) => {
    const wasRaw = stdin.isRaw;
    if (stdin.setRawMode) stdin.setRawMode(true);

    function cleanup() {
      stdin.removeListener("data", onData);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
    }

    function move(delta: number) {
      if (filtered.length === 0) return;
      selected = (selected + delta + filtered.length) % filtered.length;
      const visibleCount = getVisibleCount();
      if (selected < scrollOffset) scrollOffset = selected;
      if (selected >= scrollOffset + visibleCount) scrollOffset = selected - visibleCount + 1;
      render();
    }

    function onData(buf: Buffer) {
      const key = buf.toString();

      // Escape or Ctrl+C: cancel
      if (key === "\x1b" || key === "\x03") {
        cleanup(); clear(); resolve(undefined); return;
      }

      // Enter: select current item, or submit typed text as command
      if (key === "\r" || key === "\n") {
        cleanup(); clear();
        if (filtered.length > 0) {
          resolve(`/${filtered[selected].name}`);
        } else if (filter) {
          resolve(`/${filter}`);
        } else {
          resolve(undefined);
        }
        return;
      }

      // Arrow up/down: navigate
      if (key === "\x1b[A") { move(-1); return; }
      if (key === "\x1b[B") { move(1); return; }

      // Backspace: remove last char from filter, or dismiss menu if empty
      if (key === "\x7f" || key === "\b") {
        if (filter.length > 0) {
          filter = filter.slice(0, -1);
          applyFilter();
          render();
        } else {
          // Filter empty — dismiss menu (same as Escape)
          cleanup(); clear(); resolve(undefined);
        }
        return;
      }

      // Tab: complete with selected item name
      if (key === "\t") {
        if (filtered.length > 0) {
          filter = filtered[selected].name;
          applyFilter();
          render();
        }
        return;
      }

      // Printable characters: add to filter
      if (key.length === 1 && key >= " " && key <= "~") {
        filter += key;
        applyFilter();
        render();
        return;
      }
    }

    stdin.on("data", onData);
  });
}
