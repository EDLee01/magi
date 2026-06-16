import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { MagiConfigError } from "../errors.js";
import { MagiPaths } from "../paths.js";

export interface SkillRecord {
  name: string;
  root: string;
  summary: string;
  body?: string;
}

export function listSkills(paths: MagiPaths): SkillRecord[] {
  let entries: string[];
  try {
    entries = readdirSync(paths.skillsRoot);
  } catch {
    return [];
  }
  return entries.sort().flatMap((name) => {
    const root = path.join(paths.skillsRoot, name);
    const file = path.join(root, "SKILL.md");
    try {
      if (!statSync(file).isFile()) {
        return [];
      }
      return [loadSkill(root, false)];
    } catch {
      return [];
    }
  });
}

export function loadSkill(root: string, includeBody = true): SkillRecord {
  const name = path.basename(root);
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(name)) {
    throw new MagiConfigError(`Invalid skill directory name: ${name}`);
  }
  const body = readFileSync(path.join(root, "SKILL.md"), "utf8");
  const summary = skillSummary(body) ?? name;
  return {
    name,
    root,
    summary,
    body: includeBody ? body : undefined
  };
}

export function findSkill(paths: MagiPaths, name: string): SkillRecord | undefined {
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(name)) {
    return undefined;
  }
  const root = path.resolve(paths.skillsRoot, name);
  const skillsRoot = path.resolve(paths.skillsRoot);
  if (root !== skillsRoot && !root.startsWith(`${skillsRoot}${path.sep}`)) {
    return undefined;
  }
  try {
    return loadSkill(root, true);
  } catch {
    return undefined;
  }
}

export function formatSkillList(skills: SkillRecord[]): string {
  if (skills.length === 0) {
    return "No skills installed\n";
  }
  return `${skills.map((skill) => `${skill.name}\t${skill.summary}\t${skill.root}`).join("\n")}\n`;
}

function skillSummary(body: string): string | undefined {
  return frontmatterDescription(body) ?? firstMeaningfulLine(body);
}

function frontmatterDescription(body: string): string | undefined {
  const lines = body.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return undefined;
  }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") {
      break;
    }
    const match = /^description:\s*(.*)$/i.exec(line);
    if (match) {
      const value = match[1].trim().replace(/^["']|["']$/g, "").trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function firstMeaningfulLine(body: string): string | undefined {
  const lines = body.split(/\r?\n/);
  let inFrontmatter = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmedLine = lines[i].trim();
    if (i === 0 && trimmedLine === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (trimmedLine === "---") {
        inFrontmatter = false;
      }
      continue;
    }
    const trimmed = lines[i].replace(/^#+\s*/, "").trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}
