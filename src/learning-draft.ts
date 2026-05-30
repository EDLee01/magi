import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { atomicWrite } from "./fs-utils.js";
import {
  appendMemoryFile,
  ensureMemoryStructure,
  isMemoryContentSafe,
  resolveMemoryFilePath
} from "./memory-files.js";

export type LearningDraftKind = "memory" | "skill_create" | "skill_patch" | "do_not_save";
export type LearningDraftStatus = "pending" | "applied" | "rejected";

export interface LearningDraft {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: LearningDraftStatus;
  kind: LearningDraftKind;
  target: string;
  content: string;
  reason: string;
  sourceSession?: string;
  evidence: string[];
  confidence?: number;
  requiresReview: boolean;
}

export interface LearningDraftRecord {
  id: string;
  path: string;
  status: LearningDraftStatus;
  kind: LearningDraftKind;
  target: string;
  createdAt: string;
}

export interface LearningDraftRootOptions {
  appRoot: string;
  memoryRoot?: string;
  skillsRoot?: string;
}

export function proposeLearningDraft(
  input: LearningDraftRootOptions & {
    kind: LearningDraftKind;
    target: string;
    content: string;
    reason: string;
    sourceSession?: string;
    evidence?: string[];
    confidence?: number;
    id?: string;
  }
): LearningDraft {
  const content = input.content.trim();
  if (!content) {
    throw new Error("LearningDraft content must not be empty");
  }
  if (!isMemoryContentSafe(content)) {
    throw new Error(
      "LearningDraft rejected because it appears to contain a secret, token, password, or API key"
    );
  }
  validateLearningTarget(input);
  const now = new Date().toISOString();
  const draft: LearningDraft = {
    id: input.id ?? createLearningDraftId(),
    createdAt: now,
    updatedAt: now,
    status: "pending",
    kind: input.kind,
    target: input.target.trim(),
    content,
    reason: input.reason.trim() || "Learning proposed by agent",
    sourceSession: input.sourceSession,
    evidence: normalizeEvidence(input.evidence),
    confidence: input.confidence,
    requiresReview: true
  };
  const file = learningDraftFilePath(input.appRoot, draft.id);
  mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, `${JSON.stringify(draft, null, 2)}\n`);
  return draft;
}

export function listLearningDrafts(input: LearningDraftRootOptions): LearningDraftRecord[] {
  const root = learningDraftsRoot(input.appRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      const file = path.join(root, name);
      try {
        if (!statSync(file).isFile()) return [];
        const draft = readLearningDraft(file);
        return [
          {
            id: draft.id,
            path: file,
            status: draft.status,
            kind: draft.kind,
            target: draft.target,
            createdAt: draft.createdAt
          }
        ];
      } catch {
        return [];
      }
    });
}

export function showLearningDraft(input: LearningDraftRootOptions & { id: string }): LearningDraft {
  return readLearningDraft(learningDraftFilePath(input.appRoot, input.id));
}

export function applyLearningDraft(
  input: LearningDraftRootOptions & { id: string }
): LearningDraft {
  const file = learningDraftFilePath(input.appRoot, input.id);
  const draft = readLearningDraft(file);
  if (draft.status !== "pending") {
    throw new Error(`LearningDraft is not pending: ${draft.id}`);
  }
  applyLearningDraftContent(input, draft);
  return updateLearningDraftStatus(file, draft, "applied");
}

export function rejectLearningDraft(
  input: LearningDraftRootOptions & { id: string }
): LearningDraft {
  const file = learningDraftFilePath(input.appRoot, input.id);
  const draft = readLearningDraft(file);
  if (draft.status !== "pending") {
    throw new Error(`LearningDraft is not pending: ${draft.id}`);
  }
  return updateLearningDraftStatus(file, draft, "rejected");
}

export function formatLearningDraftList(records: LearningDraftRecord[]): string {
  if (records.length === 0) return "No LearningDrafts.";
  return [
    "LearningDrafts:",
    ...records.map(
      (draft) =>
        `  ${draft.id}  ${draft.status.padEnd(8)}  ${draft.kind.padEnd(12)}  ${draft.target}`
    )
  ].join("\n");
}

export function formatLearningDraftReview(
  input: LearningDraftRootOptions & { id: string }
): string {
  const draft = showLearningDraft(input);
  return [
    `LearningDraft: ${draft.id}`,
    `Status: ${draft.status}`,
    `Kind: ${draft.kind}`,
    `Target: ${draft.target}`,
    `Reason: ${draft.reason}`,
    draft.sourceSession ? `Source session: ${draft.sourceSession}` : undefined,
    draft.confidence !== undefined ? `Confidence: ${draft.confidence}` : undefined,
    draft.evidence.length > 0 ? "Evidence:" : undefined,
    ...draft.evidence.map((item) => `- ${item}`),
    "",
    "Preview:",
    "```md",
    draft.content,
    "```",
    "",
    `Apply: magi learning draft apply ${draft.id}`,
    `Reject: magi learning draft reject ${draft.id}`
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function maybeProposePostTaskLearningDraft(
  input: LearningDraftRootOptions & {
    prompt: string;
    answer: string;
    sourceSession?: string;
    cwd: string;
    events?: Array<Record<string, unknown>>;
  }
): LearningDraft | undefined {
  const events = input.events ?? [];
  const toolResults = events.filter((event) => event.type === "tool_result");
  const failedTools = toolResults.filter((event) => event.isError === true);
  const explicitLearning =
    /\b(remember|learn|lesson|workflow|preference|next time)\b/i.test(input.prompt) ||
    /(记住|学习|沉淀|复用|下次|偏好|工作流)/.test(input.prompt);
  const complexEnough =
    toolResults.length >= 4 || failedTools.length >= 2 || input.prompt.length > 500;
  if (!explicitLearning && !complexEnough) {
    return undefined;
  }

  const title = summarizePrompt(input.prompt);
  const evidence = [
    input.sourceSession ? `source session: ${input.sourceSession}` : undefined,
    `cwd: ${input.cwd}`,
    `tool results: ${toolResults.length}`,
    failedTools.length > 0 ? `failed tool results: ${failedTools.length}` : undefined,
    `assistant response length: ${input.answer.length}`
  ].filter((item): item is string => item !== undefined);
  const content = [
    `## Learned Workflow: ${title}`,
    "",
    `Source session: ${input.sourceSession ?? "unknown"}`,
    `Working directory: ${input.cwd}`,
    "",
    "**When to use**",
    "",
    truncateBlock(input.prompt, 500),
    "",
    "**Reusable lesson**",
    "",
    "Review this draft before applying. Keep only stable workflow facts, durable project context, or reusable troubleshooting steps.",
    "",
    "**Evidence**",
    "",
    ...evidence.map((item) => `- ${item}`),
    "",
    "**Completed result excerpt**",
    "",
    truncateBlock(input.answer, 700)
  ].join("\n");

  try {
    return proposeLearningDraft({
      appRoot: input.appRoot,
      memoryRoot: input.memoryRoot,
      skillsRoot: input.skillsRoot,
      kind: "memory",
      target: "workflows/README.md",
      content,
      reason: explicitLearning
        ? "The user explicitly asked Magi to remember, learn, or reuse this workflow."
        : "A complex task produced enough tool evidence to justify a reviewable learning draft.",
      sourceSession: input.sourceSession,
      evidence,
      confidence: explicitLearning ? 0.75 : 0.55
    });
  } catch {
    return undefined;
  }
}

function applyLearningDraftContent(input: LearningDraftRootOptions, draft: LearningDraft): void {
  if (draft.kind === "do_not_save") {
    return;
  }
  if (draft.kind === "memory") {
    appendMemoryFile({
      appRoot: input.appRoot,
      root: input.memoryRoot,
      filePath: draft.target,
      content: formatMemoryLearningDraftContent(draft)
    });
    return;
  }
  if (draft.kind === "skill_create") {
    const skillName = skillNameFromTarget(draft.target);
    const skillRoot = resolveSkillRoot(input, skillName);
    const skillFile = path.join(skillRoot, "SKILL.md");
    if (existsSync(skillFile)) {
      throw new Error(`Skill already exists: ${skillName}`);
    }
    mkdirSync(skillRoot, { recursive: true });
    atomicWrite(skillFile, normalizeMarkdown(draft.content));
    return;
  }
  if (draft.kind === "skill_patch") {
    const skillName = skillNameFromTarget(draft.target);
    const skillRoot = resolveSkillRoot(input, skillName);
    const skillFile = path.join(skillRoot, "SKILL.md");
    if (!existsSync(skillFile)) {
      throw new Error(`Skill not found: ${skillName}`);
    }
    const before = readFileSync(skillFile, "utf8");
    const replacement = parseSkillPatchReplacement(draft.content);
    if (replacement) {
      const occurrences = countOccurrences(before, replacement.oldString);
      if (occurrences === 0) {
        throw new Error(`Skill patch old_string was not found: ${skillName}`);
      }
      if (occurrences > 1) {
        throw new Error(`Skill patch old_string is not unique: ${skillName}`);
      }
      const after = before.replace(replacement.oldString, replacement.newString);
      atomicWrite(skillFile, after);
      return;
    }
    const addition = [
      before.endsWith("\n") ? "" : "\n",
      "",
      `<!-- LearningDraft ${draft.id} -->`,
      draft.content.trim(),
      ""
    ].join("\n");
    atomicWrite(skillFile, before + addition);
    return;
  }
}

function updateLearningDraftStatus(
  file: string,
  draft: LearningDraft,
  status: LearningDraftStatus
): LearningDraft {
  const next: LearningDraft = {
    ...draft,
    status,
    updatedAt: new Date().toISOString()
  };
  atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function formatMemoryLearningDraftContent(draft: LearningDraft): string {
  return [draft.content.trimEnd(), "", `<!-- LearningDraft ${draft.id} -->`].join("\n");
}

function validateLearningTarget(
  input: LearningDraftRootOptions & {
    kind: LearningDraftKind;
    target: string;
  }
): void {
  const target = input.target.trim();
  if (!target || target.includes("\0")) {
    throw new Error("LearningDraft target must not be empty");
  }
  if (input.kind === "memory") {
    const root = ensureMemoryStructure({ appRoot: input.appRoot, root: input.memoryRoot });
    resolveMemoryFilePath(root, target);
    return;
  }
  if (input.kind === "skill_create" || input.kind === "skill_patch") {
    skillNameFromTarget(target);
    return;
  }
}

function readLearningDraft(file: string): LearningDraft {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as LearningDraft;
  if (!parsed.id || !parsed.kind || !parsed.target || !parsed.status || !parsed.content) {
    throw new Error(`Invalid LearningDraft: ${file}`);
  }
  if (
    parsed.kind !== "memory" &&
    parsed.kind !== "skill_create" &&
    parsed.kind !== "skill_patch" &&
    parsed.kind !== "do_not_save"
  ) {
    throw new Error(`Invalid LearningDraft kind: ${parsed.kind}`);
  }
  return {
    ...parsed,
    evidence: Array.isArray(parsed.evidence)
      ? parsed.evidence.filter((item) => typeof item === "string")
      : [],
    requiresReview: true
  };
}

function learningDraftsRoot(appRoot: string): string {
  return path.join(appRoot, "state", "learning-drafts");
}

function learningDraftFilePath(appRoot: string, id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeId) throw new Error("LearningDraft id must not be empty");
  return path.join(learningDraftsRoot(appRoot), `${safeId}.json`);
}

function createLearningDraftId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14);
  return `learn_${stamp}_${randomUUID().slice(0, 8)}`;
}

function normalizeEvidence(value: string[] | undefined): string[] {
  return (value ?? [])
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 10);
}

function skillNameFromTarget(target: string): string {
  const normalized = target.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  const match =
    /^skills\/([^/]+)\/SKILL\.md$/.exec(normalized) ??
    /^([^/]+)\/SKILL\.md$/.exec(normalized) ??
    /^([^/]+)$/.exec(normalized);
  const name = match?.[1];
  if (!name || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(name)) {
    throw new Error("Skill target must be a skill name or skills/<name>/SKILL.md");
  }
  return name;
}

function resolveSkillRoot(input: LearningDraftRootOptions, name: string): string {
  const root = path.resolve(input.skillsRoot ?? path.join(input.appRoot, "skills"));
  const skillRoot = path.resolve(root, name);
  const relative = path.relative(root, skillRoot);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Skill target escapes skills root: ${name}`);
  }
  return skillRoot;
}

function normalizeMarkdown(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function parseSkillPatchReplacement(
  content: string
): { oldString: string; newString: string } | undefined {
  const oldString = extractFencedBlock(content, "old_string");
  const newString = extractFencedBlock(content, "new_string");
  if (oldString === undefined && newString === undefined) {
    return undefined;
  }
  if (oldString === undefined || newString === undefined || !oldString) {
    throw new Error("Skill patch replacement requires old_string and new_string fenced blocks");
  }
  return { oldString, newString };
}

function extractFencedBlock(content: string, label: string): string | undefined {
  const pattern = new RegExp(
    `(?:^|\\n)${label}:\\s*\\n\`\`\`(?:[^\\n]*)\\n([\\s\\S]*?)\\n\`\`\``,
    "i"
  );
  return pattern.exec(content)?.[1];
}

function countOccurrences(value: string, search: string): number {
  if (!search) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(search, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + search.length;
  }
}

function summarizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 80) || "session";
}

function truncateBlock(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}
