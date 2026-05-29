import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { getGitSummary } from "./git.js";
import { resolveWorkspacePath } from "./workspace.js";

export interface WorkspaceDiagnosticsRequest {
  path?: string;
  format: "text" | "json";
  maxFiles: number;
}

export interface WorkspaceDiagnostics {
  root: string;
  scan: {
    fileCount: number;
    directoryCount: number;
    sampledFiles: string[];
    truncated: boolean;
    ignoredDirectories: string[];
  };
  manifests: string[];
  packageJson?: {
    name?: string;
    packageManager?: string;
    scripts: Record<string, string>;
    dependencies: string[];
    devDependencies: string[];
  };
  packageManager?: string;
  languages: Array<{ name: string; files: number }>;
  frameworks: string[];
  suggestedCommands: string[];
  git: {
    available: boolean;
    repository: boolean;
    branch?: string;
    status?: string;
    diffStat?: string;
    reason?: string;
  };
  warnings: string[];
}

export const WorkspaceDiagnosticsInputSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    format: { type: "string", enum: ["text", "json"] },
    max_files: { type: "number" }
  },
  required: [],
  additionalProperties: false
};

const IGNORED_DIRECTORIES = [
  ".claude",
  ".git",
  ".magi-next",
  ".next",
  ".turbo",
  ".venv",
  "coverage",
  "dist",
  "node_modules",
  "target"
];

const MANIFEST_FILES = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "Cargo.toml",
  "Cargo.lock",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "go.sum",
  "deno.json",
  "deno.jsonc",
  "tsconfig.json",
  "jsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "vitest.config.ts",
  "vitest.config.js",
  "jest.config.ts",
  "jest.config.js",
  "playwright.config.ts",
  "playwright.config.js",
  "Makefile",
  "Dockerfile",
  "README.md",
  "AGENTS.md"
];

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".c": "C",
  ".cc": "C++",
  ".cpp": "C++",
  ".cs": "C#",
  ".go": "Go",
  ".java": "Java",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".mjs": "JavaScript",
  ".php": "PHP",
  ".py": "Python",
  ".rb": "Ruby",
  ".rs": "Rust",
  ".sh": "Shell",
  ".swift": "Swift",
  ".ts": "TypeScript",
  ".tsx": "TypeScript"
};

export function parseWorkspaceDiagnosticsInput(
  input: Record<string, unknown>
): WorkspaceDiagnosticsRequest {
  assertAllowedKeys(input, ["path", "format", "max_files"]);
  const format = input.format === undefined ? "text" : readFormat(input.format);
  const maxFiles = input.max_files === undefined ? 2_000 : readMaxFiles(input.max_files);
  return {
    path: readOptionalString(input.path, "path"),
    format,
    maxFiles
  };
}

export function runWorkspaceDiagnostics(input: {
  cwd: string;
  request?: Partial<WorkspaceDiagnosticsRequest>;
}): WorkspaceDiagnostics {
  const request = {
    format: input.request?.format ?? "text",
    maxFiles: input.request?.maxFiles ?? 2_000,
    path: input.request?.path
  };
  const root = request.path
    ? resolveWorkspacePath(input.cwd, request.path).absolutePath
    : input.cwd;
  const rootStat = statSync(root);
  if (!rootStat.isDirectory()) {
    throw new Error(`Workspace diagnostics path must be a directory: ${request.path ?? "."}`);
  }

  const scan = scanWorkspace(root, request.maxFiles);
  const manifests = MANIFEST_FILES.filter((file) => existsSync(path.join(root, file)));
  const packageJson = readPackageJson(root);
  const packageManager = detectPackageManager(root, packageJson);
  const languages = detectLanguages(scan.sampledFiles);
  const frameworks = detectFrameworks(root, packageJson, manifests);
  const git = getGitSummary(root);
  const warnings = buildWarnings({ packageJson, packageManager, manifests, languages });

  return {
    root,
    scan,
    manifests,
    packageJson,
    packageManager,
    languages,
    frameworks,
    suggestedCommands: suggestCommands({ root, packageJson, packageManager, manifests }),
    git: {
      available: git.gitAvailable,
      repository: git.isRepository,
      branch: git.branch,
      status: git.status,
      diffStat: git.diffStat,
      reason: git.reason
    },
    warnings
  };
}

export function formatWorkspaceDiagnostics(
  diagnostics: WorkspaceDiagnostics,
  format: "text" | "json" = "text"
): string {
  if (format === "json") {
    return `${JSON.stringify(diagnostics, null, 2)}\n`;
  }

  const scripts = Object.entries(diagnostics.packageJson?.scripts ?? {});
  return [
    "Workspace Diagnostics",
    `root: ${diagnostics.root}`,
    `files scanned: ${diagnostics.scan.fileCount}${diagnostics.scan.truncated ? " (truncated)" : ""}`,
    `directories scanned: ${diagnostics.scan.directoryCount}`,
    `package manager: ${diagnostics.packageManager ?? "none detected"}`,
    `manifests: ${diagnostics.manifests.length > 0 ? diagnostics.manifests.join(", ") : "none detected"}`,
    `languages: ${diagnostics.languages.length > 0 ? diagnostics.languages.map((item) => `${item.name} (${item.files})`).join(", ") : "none detected"}`,
    `frameworks: ${diagnostics.frameworks.length > 0 ? diagnostics.frameworks.join(", ") : "none detected"}`,
    "",
    "Package scripts:",
    ...(scripts.length > 0
      ? scripts.map(([name, command]) => `- ${name}: ${command}`)
      : ["- none detected"]),
    "",
    "Suggested commands:",
    ...(diagnostics.suggestedCommands.length > 0
      ? diagnostics.suggestedCommands.map((command) => `- ${command}`)
      : ["- none detected"]),
    "",
    "Git:",
    `- available: ${diagnostics.git.available ? "true" : "false"}`,
    `- repository: ${diagnostics.git.repository ? "true" : "false"}`,
    diagnostics.git.branch ? `- branch: ${diagnostics.git.branch}` : undefined,
    diagnostics.git.status
      ? `- status:\n${indent(diagnostics.git.status)}`
      : diagnostics.git.repository
        ? "- status: clean"
        : undefined,
    diagnostics.git.diffStat ? `- diffStat:\n${indent(diagnostics.git.diffStat)}` : undefined,
    diagnostics.git.reason ? `- reason: ${diagnostics.git.reason}` : undefined,
    "",
    "Warnings:",
    ...(diagnostics.warnings.length > 0
      ? diagnostics.warnings.map((warning) => `- ${warning}`)
      : ["- none"]),
    "",
    "Note: diagnostics are read-only; suggested commands were not executed.",
    ""
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function scanWorkspace(root: string, maxFiles: number): WorkspaceDiagnostics["scan"] {
  const sampledFiles: string[] = [];
  let fileCount = 0;
  let directoryCount = 0;
  let truncated = false;
  const stack = [root];
  const ignored = new Set(IGNORED_DIRECTORIES);

  while (stack.length > 0) {
    const current = stack.pop()!;
    directoryCount += 1;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name)
      );
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) {
          stack.push(absolute);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      fileCount += 1;
      if (sampledFiles.length < maxFiles) {
        sampledFiles.push(toPosix(path.relative(root, absolute)));
      } else {
        truncated = true;
      }
    }
  }

  sampledFiles.sort();
  return {
    fileCount,
    directoryCount,
    sampledFiles,
    truncated,
    ignoredDirectories: [...ignored].sort()
  };
}

function readPackageJson(root: string): WorkspaceDiagnostics["packageJson"] | undefined {
  const file = path.join(root, "package.json");
  if (!existsSync(file)) {
    return undefined;
  }
  const raw = readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    return undefined;
  }
  return {
    name: typeof parsed.name === "string" ? parsed.name : undefined,
    packageManager: typeof parsed.packageManager === "string" ? parsed.packageManager : undefined,
    scripts: readStringRecord(parsed.scripts),
    dependencies: Object.keys(readStringRecord(parsed.dependencies)).sort(),
    devDependencies: Object.keys(readStringRecord(parsed.devDependencies)).sort()
  };
}

function detectPackageManager(
  root: string,
  packageJson: WorkspaceDiagnostics["packageJson"] | undefined
): string | undefined {
  if (packageJson?.packageManager) {
    return packageJson.packageManager.split("@")[0];
  }
  if (existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(root, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(root, "bun.lockb")) || existsSync(path.join(root, "bun.lock")))
    return "bun";
  if (existsSync(path.join(root, "package-lock.json"))) return "npm";
  return packageJson ? "npm" : undefined;
}

function detectLanguages(files: string[]): Array<{ name: string; files: number }> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const language = LANGUAGE_BY_EXTENSION[path.extname(file).toLowerCase()];
    if (language) {
      counts.set(language, (counts.get(language) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, files: count }))
    .sort((left, right) => right.files - left.files || left.name.localeCompare(right.name));
}

function detectFrameworks(
  root: string,
  packageJson: WorkspaceDiagnostics["packageJson"] | undefined,
  manifests: string[]
): string[] {
  const result = new Set<string>();
  const deps = new Set([
    ...(packageJson?.dependencies ?? []),
    ...(packageJson?.devDependencies ?? [])
  ]);
  for (const [dependency, label] of [
    ["next", "Next.js"],
    ["react", "React"],
    ["vue", "Vue"],
    ["svelte", "Svelte"],
    ["vite", "Vite"],
    ["vitest", "Vitest"],
    ["jest", "Jest"],
    ["playwright", "Playwright"],
    ["typescript", "TypeScript"],
    ["eslint", "ESLint"]
  ]) {
    if (deps.has(dependency)) {
      result.add(label);
    }
  }
  if (
    existsSync(path.join(root, "next.config.js")) ||
    existsSync(path.join(root, "next.config.mjs")) ||
    existsSync(path.join(root, "next.config.ts"))
  ) {
    result.add("Next.js");
  }
  if (manifests.some((file) => file.startsWith("vite.config"))) result.add("Vite");
  if (manifests.some((file) => file.startsWith("vitest.config"))) result.add("Vitest");
  if (manifests.some((file) => file.startsWith("jest.config"))) result.add("Jest");
  if (manifests.some((file) => file.startsWith("playwright.config"))) result.add("Playwright");
  if (manifests.includes("Cargo.toml")) result.add("Cargo");
  if (manifests.includes("go.mod")) result.add("Go modules");
  if (manifests.includes("pyproject.toml")) result.add("Python project");
  return [...result].sort();
}

function suggestCommands(input: {
  root: string;
  packageJson: WorkspaceDiagnostics["packageJson"] | undefined;
  packageManager: string | undefined;
  manifests: string[];
}): string[] {
  const commands: string[] = [];
  if (input.packageJson) {
    commands.push(packageInstallCommand(input.packageManager));
    for (const script of ["verify", "test", "type", "typecheck", "lint", "build", "dev", "start"]) {
      if (input.packageJson.scripts[script]) {
        commands.push(packageRunCommand(input.packageManager, script));
      }
    }
  }
  if (input.manifests.includes("Cargo.toml")) {
    commands.push("cargo test", "cargo build");
  }
  if (input.manifests.includes("pyproject.toml") || input.manifests.includes("requirements.txt")) {
    commands.push("python -m pytest");
  }
  if (input.manifests.includes("go.mod")) {
    commands.push("go test ./...");
  }
  if (input.manifests.includes("Makefile")) {
    commands.push(...readMakeTargets(input.root).map((target) => `make ${target}`));
  }
  return dedupe(commands);
}

function buildWarnings(input: {
  packageJson: WorkspaceDiagnostics["packageJson"] | undefined;
  packageManager: string | undefined;
  manifests: string[];
  languages: Array<{ name: string; files: number }>;
}): string[] {
  const warnings: string[] = [];
  if (input.packageJson && Object.keys(input.packageJson.scripts).length === 0) {
    warnings.push("package.json has no scripts");
  }
  if (input.packageJson && !input.packageManager) {
    warnings.push("package.json found but package manager could not be inferred");
  }
  if (
    input.languages.some((item) => item.name === "TypeScript") &&
    !input.manifests.includes("tsconfig.json")
  ) {
    warnings.push(
      "TypeScript files detected but tsconfig.json was not found at the diagnostics root"
    );
  }
  if (!input.manifests.includes("README.md")) {
    warnings.push("README.md was not found at the diagnostics root");
  }
  if (!input.manifests.includes("AGENTS.md")) {
    warnings.push("AGENTS.md was not found at the diagnostics root");
  }
  return warnings;
}

function readMakeTargets(root: string): string[] {
  const file = path.join(root, "Makefile");
  if (!existsSync(file)) {
    return [];
  }
  const text = readFileSync(file, "utf8");
  const targets = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.-]+):(?:\s|$)/.exec(line);
    if (match && (match[1] === "test" || match[1] === "build" || match[1] === "lint")) {
      targets.add(match[1]);
    }
  }
  return [...targets].sort();
}

function packageInstallCommand(packageManager: string | undefined): string {
  if (packageManager === "pnpm") return "pnpm install";
  if (packageManager === "yarn") return "yarn install";
  if (packageManager === "bun") return "bun install";
  return "npm install";
}

function packageRunCommand(packageManager: string | undefined, script: string): string {
  if (packageManager === "pnpm") return `pnpm run ${script}`;
  if (packageManager === "yarn") return `yarn ${script}`;
  if (packageManager === "bun") return `bun run ${script}`;
  return `npm run ${script}`;
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      result[key] = item;
    }
  }
  return result;
}

function readOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`WorkspaceDiagnostics input ${name} must be a non-empty string`);
  }
  return value;
}

function readFormat(value: unknown): "text" | "json" {
  if (value === "text" || value === "json") {
    return value;
  }
  throw new Error("WorkspaceDiagnostics input format must be text or json");
}

function readMaxFiles(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 20_000) {
    throw new Error("WorkspaceDiagnostics input max_files must be an integer from 1 to 20000");
  }
  return value;
}

function assertAllowedKeys(input: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!allowedSet.has(key)) {
      throw new Error(`WorkspaceDiagnostics input has unknown field: ${key}`);
    }
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function indent(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
