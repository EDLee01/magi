import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { atomicWrite } from "../fs-utils.js";
import { findSkill, formatSkillList, listSkills } from "../skills/loader.js";
import { createUnifiedDiff } from "./files.js";

export interface SkillManageRequest {
  action: "list" | "show" | "create" | "patch" | "write_file";
  name?: string;
  content?: string;
  filePath?: string;
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
}

export const SkillManageInputSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "show", "create", "patch", "write_file"] },
    name: { type: "string", description: "Skill directory name, e.g. debug-api-flake." },
    content: { type: "string", description: "Full file content for create/write_file." },
    file_path: {
      type: "string",
      description: "Skill-relative file path. Defaults to SKILL.md for patch."
    },
    old_string: { type: "string", description: "Existing text to replace for patch." },
    new_string: { type: "string", description: "Replacement text for patch." },
    replace_all: { type: "boolean" }
  },
  required: ["action"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseSkillManageInput(input: Record<string, unknown>): SkillManageRequest {
  assertAllowedKeys(
    input,
    ["action", "name", "content", "file_path", "old_string", "new_string", "replace_all"],
    "SkillManage input"
  );
  const action = readAction(input.action);
  return {
    action,
    name: readOptionalString(input.name, "name"),
    content: readOptionalString(input.content, "content"),
    filePath: readOptionalString(input.file_path, "file_path"),
    oldString: readOptionalString(input.old_string, "old_string"),
    newString: readOptionalString(input.new_string, "new_string"),
    replaceAll: readOptionalBoolean(input.replace_all, "replace_all")
  };
}

export function executeSkillManage(input: {
  request: SkillManageRequest;
  skillsRoot: string;
}): string {
  mkdirSync(input.skillsRoot, { recursive: true });
  const request = input.request;
  if (request.action === "list") {
    return formatSkillList(listSkills(pathsFromSkillsRoot(input.skillsRoot))).trimEnd();
  }
  const name = requireSkillName(request.name);
  if (request.action === "show") {
    const skill = findSkill(pathsFromSkillsRoot(input.skillsRoot), name);
    if (!skill) throw new Error(`Skill not found: ${name}`);
    return [
      `Skill: ${skill.name}`,
      `Root: ${skill.root}`,
      `Summary: ${skill.summary}`,
      "",
      skill.body ?? ""
    ]
      .join("\n")
      .trimEnd();
  }
  if (request.action === "create") {
    const content = requireContent(request.content, "content");
    const skillRoot = resolveSkillRoot(input.skillsRoot, name);
    const skillFile = path.join(skillRoot, "SKILL.md");
    if (existsSync(skillFile)) {
      throw new Error(`Skill already exists: ${name}`);
    }
    mkdirSync(skillRoot, { recursive: true });
    const normalized = normalizeMarkdown(content);
    atomicWrite(skillFile, normalized);
    return [
      `Created skill: ${name}`,
      `File: ${skillFile}`,
      createUnifiedDiff(`skills/${name}/SKILL.md`, "", normalized)
    ].join("\n");
  }
  if (request.action === "patch") {
    const oldString = requireContent(request.oldString, "old_string");
    const newString = request.newString ?? "";
    const skillFile = resolveSkillFile(input.skillsRoot, name, request.filePath ?? "SKILL.md");
    const before = readFileSync(skillFile, "utf8");
    const occurrences = countOccurrences(before, oldString);
    if (occurrences === 0) {
      throw new Error(`old_string was not found in ${path.relative(input.skillsRoot, skillFile)}`);
    }
    if (occurrences > 1 && request.replaceAll !== true) {
      throw new Error(
        `old_string appears ${occurrences} times; set replace_all=true or make it unique`
      );
    }
    const after =
      request.replaceAll === true
        ? before.split(oldString).join(newString)
        : before.replace(oldString, newString);
    atomicWrite(skillFile, after);
    const rel = path.relative(path.dirname(input.skillsRoot), skillFile).replace(/\\/g, "/");
    return [
      `Patched skill: ${name}`,
      `File: ${skillFile}`,
      createUnifiedDiff(rel, before, after)
    ].join("\n");
  }
  if (request.action === "write_file") {
    const content = requireContent(request.content, "content");
    const filePath = request.filePath ?? "SKILL.md";
    const skillFile = resolveSkillFile(input.skillsRoot, name, filePath, { allowMissing: true });
    mkdirSync(path.dirname(skillFile), { recursive: true });
    const before = existsSync(skillFile) ? readFileSync(skillFile, "utf8") : "";
    const after = normalizeMarkdown(content);
    atomicWrite(skillFile, after);
    const rel = path.relative(path.dirname(input.skillsRoot), skillFile).replace(/\\/g, "/");
    return [
      `Wrote skill file: ${name}`,
      `File: ${skillFile}`,
      createUnifiedDiff(rel, before, after)
    ].join("\n");
  }
  return `Unknown SkillManage action: ${request.action}`;
}

export function skillManagePreview(input: {
  request: SkillManageRequest;
  skillsRoot: string;
}): string | undefined {
  try {
    const request = input.request;
    if (request.action === "create") {
      const name = requireSkillName(request.name);
      const content = normalizeMarkdown(requireContent(request.content, "content"));
      return createUnifiedDiff(`skills/${name}/SKILL.md`, "", content);
    }
    if (request.action === "patch") {
      const name = requireSkillName(request.name);
      const skillFile = resolveSkillFile(input.skillsRoot, name, request.filePath ?? "SKILL.md");
      const before = readFileSync(skillFile, "utf8");
      const oldString = requireContent(request.oldString, "old_string");
      const newString = request.newString ?? "";
      const after =
        request.replaceAll === true
          ? before.split(oldString).join(newString)
          : before.replace(oldString, newString);
      const rel = path.relative(path.dirname(input.skillsRoot), skillFile).replace(/\\/g, "/");
      return createUnifiedDiff(rel, before, after);
    }
    if (request.action === "write_file") {
      const name = requireSkillName(request.name);
      const skillFile = resolveSkillFile(input.skillsRoot, name, request.filePath ?? "SKILL.md", {
        allowMissing: true
      });
      const before = existsSync(skillFile) ? readFileSync(skillFile, "utf8") : "";
      const after = normalizeMarkdown(requireContent(request.content, "content"));
      const rel = path.relative(path.dirname(input.skillsRoot), skillFile).replace(/\\/g, "/");
      return createUnifiedDiff(rel, before, after);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function resolveSkillRoot(skillsRoot: string, name: string): string {
  const safeName = requireSkillName(name);
  const root = path.resolve(skillsRoot);
  const skillRoot = path.resolve(root, safeName);
  const relative = path.relative(root, skillRoot);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Skill path escapes skills root: ${name}`);
  }
  return skillRoot;
}

function resolveSkillFile(
  skillsRoot: string,
  name: string,
  filePath: string,
  options: { allowMissing?: boolean } = {}
): string {
  const skillRoot = resolveSkillRoot(skillsRoot, name);
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) {
    throw new Error("Skill file path must not be empty");
  }
  if (normalized.split("/").includes("..")) {
    throw new Error(`Skill file path escapes skill root: ${filePath}`);
  }
  const absolutePath = path.resolve(skillRoot, normalized);
  const relative = path.relative(skillRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Skill file path escapes skill root: ${filePath}`);
  }
  if (!options.allowMissing && !existsSync(absolutePath)) {
    throw new Error(`Skill file not found: ${name}/${normalized}`);
  }
  return absolutePath;
}

function pathsFromSkillsRoot(skillsRoot: string) {
  const root = path.dirname(skillsRoot);
  return {
    root,
    configFile: path.join(root, "config.yaml"),
    stateRoot: path.join(root, "state"),
    sessionsRoot: path.join(root, "sessions"),
    logsRoot: path.join(root, "logs"),
    cacheRoot: path.join(root, "cache"),
    pluginsRoot: path.join(root, "plugins"),
    skillsRoot,
    devicesRoot: path.join(root, "devices"),
    sessionDbFile: path.join(root, "state", "sessions.sqlite")
  };
}

function readAction(value: unknown): SkillManageRequest["action"] {
  if (
    value === "list" ||
    value === "show" ||
    value === "create" ||
    value === "patch" ||
    value === "write_file"
  ) {
    return value;
  }
  throw new Error("Tool input action must be list, show, create, patch, or write_file");
}

function requireSkillName(value: string | undefined): string {
  if (!value || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(value)) {
    throw new Error("Skill name must match /^[a-z0-9][a-z0-9._-]{1,63}$/");
  }
  return value;
}

function requireContent(value: string | undefined, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Tool input ${label} must be a non-empty string`);
  }
  return value;
}

function normalizeMarkdown(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Tool input ${label} must be a string`);
  return value;
}

function readOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Tool input ${label} must be a boolean`);
  return value;
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown field: ${unknown[0]}`);
  }
}
