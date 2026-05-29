import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "copy",
  description: "Copy the last assistant message to the system clipboard",
  usage: "/copy",
  group: "Session",
  handler: (_args: string[], input: SlashCommandInput): string => {
    if (!input.sessionId) return "No active session.";
    const session = input.store.getSession(input.sessionId);
    if (!session) return "Session not found.";
    const last = [...session.messages].reverse().find((m) => m.role === "assistant");
    if (!last) return "No assistant message yet in this session.";
    const text = last.content;
    const result = writeClipboard(text);
    if (!result.ok) {
      return [
        "Could not write to the clipboard:",
        `  ${result.error}`,
        "",
        "Last assistant message:",
        text.length > 200 ? text.slice(0, 200) + "..." : text
      ].join("\n");
    }
    const preview = text.replace(/\s+/g, " ").trim();
    return `Copied ${text.length} chars to clipboard: ${preview.length > 80 ? preview.slice(0, 80) + "..." : preview}`;
  }
};

function writeClipboard(text: string): { ok: true } | { ok: false; error: string } {
  const cmd =
    platform() === "darwin"
      ? ["pbcopy"]
      : platform() === "win32"
        ? ["clip.exe"]
        : process.env.WAYLAND_DISPLAY
          ? ["wl-copy"]
          : ["xclip", "-selection", "clipboard"];
  try {
    const result = spawnSync(cmd[0], cmd.slice(1), { input: text, encoding: "utf8" });
    if (result.error) return { ok: false, error: `${cmd[0]}: ${result.error.message}` };
    if (result.status !== 0) return { ok: false, error: `${cmd[0]} exited ${result.status}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
