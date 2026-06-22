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
  // Prefer the frontmatter `description` (authors write it specifically as the
  // trigger/match text). Fall back to the first meaningful body line for plain
  // markdown skills. Without this, frontmatter skills got "---" as their summary
  // and were invisible to keyword recall.
  const summary = frontmatterDescription(body) ?? firstMeaningfulLine(body) ?? name;
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

function firstMeaningfulLine(body: string): string | undefined {
  for (const line of stripFrontmatter(body).split(/\r?\n/)) {
    const trimmed = line.replace(/^#+\s*/, "").trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

/**
 * Extract the YAML frontmatter `description` field, supporting single-line
 * (`description: text`), folded (`description: >`) and literal (`description: |`)
 * block scalars where the value continues on indented following lines. Returns
 * a single collapsed line suitable for a recall summary. Undefined if there is
 * no frontmatter or no description field.
 */
export function frontmatterDescription(body: string): string | undefined {
  if (!body.startsWith("---\n") && !body.startsWith("---\r\n")) return undefined;
  const lines = body.split(/\r?\n/);
  // Find the closing fence.
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return undefined;

  for (let i = 1; i < end; i++) {
    const match = /^description:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const inline = match[1].trim();
    // Block scalar (`>` folded or `|` literal): collect indented continuation.
    if (inline === ">" || inline === "|" || inline === ">-" || inline === "|-") {
      const collected: string[] = [];
      for (let j = i + 1; j < end; j++) {
        const raw = lines[j];
        if (raw.trim() === "") {
          collected.push("");
          continue;
        }
        // Continuation lines are indented; a non-indented line ends the scalar.
        if (!/^\s/.test(raw)) break;
        collected.push(raw.trim());
      }
      const joined = collected.join(" ").replace(/\s+/g, " ").trim();
      return joined || undefined;
    }
    // Inline value (may be quoted).
    const unquoted = inline.replace(/^["']/, "").replace(/["']$/, "").trim();
    return unquoted || undefined;
  }
  return undefined;
}

function stripFrontmatter(body: string): string {
  if (!body.startsWith("---\n") && !body.startsWith("---\r\n")) return body;
  const lines = body.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return lines.slice(i + 1).join("\n");
    }
  }
  return body;
}
