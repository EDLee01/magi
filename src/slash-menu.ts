import { Readable, Writable } from "node:stream";

import { showTuiPicker } from "./tui/picker.js";

export interface SlashMenuItem {
  name: string;
  description: string;
}

export async function showSlashMenu(input: {
  stdin: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => void; isRaw?: boolean };
  stdout: Pick<Writable, "write"> & { columns?: number };
  items: SlashMenuItem[];
}): Promise<string | undefined> {
  const picked = await showTuiPicker({
    stdin: input.stdin,
    stdout: input.stdout,
    title: "commands",
    items: input.items.map((item) => ({
      label: item.name,
      value: `/${item.name}`,
      description: item.description
    })),
    emptyMessage: "No matching commands",
    labelPrefix: "/",
    queryPrefix: "/",
    footer: "↑↓ navigate · Tab complete · Enter select · Esc cancel · type to filter",
    maxVisibleItems: 10
  });
  return picked;
}
