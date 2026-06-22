import path from "node:path";

import { findSkill, formatSkillList, listSkills, SkillRecord } from "../skills/loader.js";

export interface SkillToolRequest {
  skill?: string;
  args?: string;
}

export const SkillToolInputSchema = {
  type: "object",
  properties: {
    skill: { type: "string" },
    args: { type: "string" }
  },
  required: [],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseSkillToolInput(input: Record<string, unknown>): SkillToolRequest {
  assertAllowedKeys(input, ["skill", "args"], "Skill input");
  const skill = readOptionalString(input.skill, "skill");
  const args = readOptionalString(input.args, "args");
  return { skill, args };
}

export function executeSkillTool(input: { request: SkillToolRequest; skillsRoot: string }): string {
  const paths = {
    root: path.dirname(input.skillsRoot),
    configFile: path.join(path.dirname(input.skillsRoot), "config.yaml"),
    stateRoot: path.join(path.dirname(input.skillsRoot), "state"),
    sessionsRoot: path.join(path.dirname(input.skillsRoot), "sessions"),
    logsRoot: path.join(path.dirname(input.skillsRoot), "logs"),
    cacheRoot: path.join(path.dirname(input.skillsRoot), "cache"),
    pluginsRoot: path.join(path.dirname(input.skillsRoot), "plugins"),
    skillsRoot: input.skillsRoot,
    devicesRoot: path.join(path.dirname(input.skillsRoot), "devices"),
    sessionDbFile: path.join(path.dirname(input.skillsRoot), "state", "sessions.sqlite")
  };
  if (!input.request.skill) {
    return formatSkillList(listSkills(paths));
  }
  const skill = findSkill(paths, input.request.skill);
  if (!skill) {
    throw new Error(`Skill not found: ${input.request.skill}`);
  }
  return formatSkillSelection(skill, input.request.args);
}

function formatSkillSelection(skill: SkillRecord, args: string | undefined): string {
  // Explicit invocation is the strong signal: the model (or user) chose this
  // skill deliberately, so frame the body as an imperative procedure to run
  // now — not the passive "here is a skill" listing that produced weak,
  // partial execution.
  return [
    `You are now running the "${skill.name}" skill. Follow the procedure below step by step, in order, and produce output in the format it specifies. Do not skip steps or summarize the procedure away.`,
    args ? `Args: ${args}` : undefined,
    "",
    `Skill: ${skill.name}`,
    `Root: ${skill.root}`,
    `Summary: ${skill.summary}`,
    "",
    skill.body ?? ""
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
    .trimEnd();
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Tool input ${label} must be a non-empty string`);
  }
  return value.trim();
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown field: ${unknown[0]}`);
  }
}
