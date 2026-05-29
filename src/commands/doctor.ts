import { SlashCommandInput } from "./registry.js";
import { runWorkspaceDiagnostics } from "../tools/workspace-diagnostics.js";

export const command = {
  name: "doctor",
  description: "Run workspace diagnostics (package manager, languages, scripts)",
  usage: "/doctor",
  group: "Tools",
  handler: (_args: string[], input: SlashCommandInput): string => {
    const diagnostics = runWorkspaceDiagnostics({ cwd: input.cwd });
    const scriptEntries = diagnostics.packageJson
      ? Object.entries(diagnostics.packageJson.scripts).slice(0, 10)
      : [];
    return [
      "Workspace Diagnostics:",
      `  root: ${diagnostics.root}`,
      `  files: ${diagnostics.scan.fileCount} files, ${diagnostics.scan.directoryCount} dirs`,
      `  package manager: ${diagnostics.packageManager ?? "none"}`,
      `  languages: ${diagnostics.languages.map((l) => l.name).join(", ")}`,
      ...scriptEntries.map(([name, cmd]) => `  script: ${name} → ${cmd}`),
      `  git: ${diagnostics.git.repository ? `branch ${diagnostics.git.branch}` : diagnostics.git.available ? "not a git repository" : "git not available"}`
    ].join("\n");
  }
};
