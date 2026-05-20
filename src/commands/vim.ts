import { SlashCommandInput } from "./registry.js";

let vimEnabled = false;

export function isVimModeEnabled(): boolean {
  return vimEnabled;
}

export function setVimMode(enabled: boolean): void {
  vimEnabled = enabled;
}

export const command = {
  name: "vim",
  description: "Toggle vim mode for input editing",
  usage: "/vim [on|off]",
  group: "Editor",
  handler: (args: string[], _input: SlashCommandInput): string => {
    if (args.length === 0) {
      vimEnabled = !vimEnabled;
    } else if (args[0] === "on" || args[0] === "true") {
      vimEnabled = true;
    } else if (args[0] === "off" || args[0] === "false") {
      vimEnabled = false;
    } else {
      return `Unknown option: ${args[0]}. Use /vim on, /vim off, or /vim`;
    }
    return [
      `Vim mode: ${vimEnabled ? "ON" : "OFF"}`,
      vimEnabled
        ? "  - Press Escape to enter NORMAL mode\n  - Use h/l/0/$/w/b/e to navigate\n  - Use i/a/I/A/o to enter INSERT mode\n  - Use d/c/y + motion (dw, cw, yy, etc.) for operations\n  - Use x/D/p for char/line ops\n  - Press Enter to submit"
        : "  - Standard readline editing (emacs-style)"
    ].join("\n");
  }
};
