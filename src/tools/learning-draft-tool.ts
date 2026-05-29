import path from "node:path";

import {
  applyLearningDraft,
  formatLearningDraftList,
  formatLearningDraftReview,
  LearningDraftKind,
  listLearningDrafts,
  proposeLearningDraft,
  rejectLearningDraft,
  showLearningDraft
} from "../learning-draft.js";

export interface LearningDraftToolRequest {
  action: "list" | "show" | "propose" | "apply" | "reject";
  id?: string;
  kind?: LearningDraftKind;
  target?: string;
  content?: string;
  reason?: string;
  evidence?: string[];
  confidence?: number;
}

export const LearningDraftToolInputSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "show", "propose", "apply", "reject"] },
    id: { type: "string" },
    kind: { type: "string", enum: ["memory", "skill_create", "skill_patch", "do_not_save"] },
    target: { type: "string" },
    content: { type: "string" },
    reason: { type: "string" },
    evidence: { type: "array", items: { type: "string" }, maxItems: 10 },
    confidence: { type: "number" }
  },
  required: ["action"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseLearningDraftToolInput(
  input: Record<string, unknown>
): LearningDraftToolRequest {
  assertAllowedKeys(
    input,
    ["action", "id", "kind", "target", "content", "reason", "evidence", "confidence"],
    "LearningDraft input"
  );
  return {
    action: readAction(input.action),
    id: readOptionalString(input.id, "id"),
    kind: input.kind === undefined ? undefined : readKind(input.kind),
    target: readOptionalString(input.target, "target"),
    content: readOptionalString(input.content, "content"),
    reason: readOptionalString(input.reason, "reason"),
    evidence: readOptionalStringArray(input.evidence, "evidence"),
    confidence: readOptionalNumber(input.confidence, "confidence")
  };
}

export function executeLearningDraftTool(input: {
  request: LearningDraftToolRequest;
  appRoot: string;
  memoryRoot?: string;
  skillsRoot?: string;
  sourceSession?: string;
}): string {
  const rootInput = {
    appRoot: input.appRoot,
    memoryRoot: input.memoryRoot,
    skillsRoot: input.skillsRoot ?? path.join(input.appRoot, "skills")
  };
  const request = input.request;
  if (request.action === "list") {
    return formatLearningDraftList(listLearningDrafts(rootInput));
  }
  if (request.action === "show") {
    return formatLearningDraftReview({ ...rootInput, id: requireId(request.id) });
  }
  if (request.action === "apply") {
    const draft = applyLearningDraft({ ...rootInput, id: requireId(request.id) });
    return `Applied LearningDraft: ${draft.id} -> ${draft.kind}:${draft.target}`;
  }
  if (request.action === "reject") {
    const draft = rejectLearningDraft({ ...rootInput, id: requireId(request.id) });
    return `Rejected LearningDraft: ${draft.id}`;
  }
  if (request.action === "propose") {
    const draft = proposeLearningDraft({
      ...rootInput,
      kind: request.kind ?? "memory",
      target: requireField(request.target, "target"),
      content: requireField(request.content, "content"),
      reason: request.reason ?? "LearningDraft proposed by agent tool",
      sourceSession: input.sourceSession,
      evidence: request.evidence,
      confidence: request.confidence
    });
    return `Created LearningDraft: ${draft.id} -> ${draft.kind}:${draft.target}. It will not change Memory or Skills until applied.`;
  }
  return `Unknown LearningDraft action: ${request.action}`;
}

export function getLearningDraft(input: {
  id: string;
  appRoot: string;
  memoryRoot?: string;
  skillsRoot?: string;
}) {
  return showLearningDraft(input);
}

function readAction(value: unknown): LearningDraftToolRequest["action"] {
  if (
    value === "list" ||
    value === "show" ||
    value === "propose" ||
    value === "apply" ||
    value === "reject"
  ) {
    return value;
  }
  throw new Error("Tool input action must be list, show, propose, apply, or reject");
}

function readKind(value: unknown): LearningDraftKind {
  if (
    value === "memory" ||
    value === "skill_create" ||
    value === "skill_patch" ||
    value === "do_not_save"
  ) {
    return value;
  }
  throw new Error("Tool input kind must be memory, skill_create, skill_patch, or do_not_save");
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Tool input ${label} must be a non-empty string`);
  }
  return value.trim();
}

function readOptionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`Tool input ${label} must be an array`);
  if (value.length > 10) throw new Error(`Tool input ${label} must contain at most 10 items`);
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`Tool input ${label}.${index} must be a string`);
    }
    return item;
  });
}

function readOptionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Tool input ${label} must be a number`);
  }
  return value;
}

function requireId(value: string | undefined): string {
  return requireField(value, "id");
}

function requireField(value: string | undefined, label: string): string {
  if (!value) throw new Error(`LearningDraft ${label} is required`);
  return value;
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown field: ${unknown[0]}`);
  }
}
