import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "upgrade",
  aliases: ["update"],
  description: "Show the installed Magi Next version and update instructions",
  usage: "/upgrade",
  group: "Help",
  handler: async (_args: string[], _input: SlashCommandInput): Promise<string> => {
    const lines: string[] = [];
    let installedVersion = "unknown";
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const url = await import("node:url");
      const here = url.fileURLToPath(import.meta.url);
      // Find package.json by walking up
      let dir = path.dirname(here);
      for (let i = 0; i < 6; i++) {
        const pkg = path.join(dir, "package.json");
        if (fs.existsSync(pkg)) {
          const data = JSON.parse(fs.readFileSync(pkg, "utf8"));
          installedVersion = data.version ?? "unknown";
          break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      // best-effort
    }
    lines.push(`Magi Next: ${installedVersion}`);
    lines.push("");
    // Try to fetch latest from npm registry (best-effort, short timeout)
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const response = await fetch("https://registry.npmjs.org/@magi/cli/latest", {
        signal: controller.signal
      });
      clearTimeout(timer);
      if (response.ok) {
        const info = (await response.json()) as { version?: string };
        if (info.version) {
          lines.push(`Latest on npm: ${info.version}`);
          if (info.version !== installedVersion) {
            lines.push("");
            lines.push("A newer version is available. To update:");
            lines.push("  npm install -g @magi/cli@latest");
          } else {
            lines.push("");
            lines.push("You're on the latest version.");
          }
          return lines.join("\n");
        }
      }
    } catch {
      // fall through to manual instructions
    }
    lines.push("Could not check the npm registry (offline or rate-limited).");
    lines.push("");
    lines.push("To update manually:");
    lines.push("  npm install -g @magi/cli@latest");
    lines.push("");
    lines.push("Or rebuild from source:");
    lines.push("  cd <magi-next-source> && git pull && npm install && npm run build");
    return lines.join("\n");
  }
};
