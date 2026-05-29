import { MessageRecord, SessionRecord } from "./session-store.js";
import { PlanReviewRecord } from "./plan-state.js";
import { MagiToolUsePart } from "./providers/ir.js";

export interface PlanExecutionGuardViolation {
  requiredTool: "FileRead";
  requiredPath: string;
  attemptedTool: string;
  attemptedPath: string;
  message: string;
}

interface ReadBeforeWriteRule {
  readPath: string;
  targetPath?: string;
}

export function checkPlanExecutionGuard(input: {
  plan?: PlanReviewRecord;
  session?: SessionRecord;
  toolUse: MagiToolUsePart;
}): PlanExecutionGuardViolation | undefined {
  const attemptedPath = mutableFilePath(input.toolUse);
  if (!attemptedPath || !input.plan) return undefined;
  const rule = readBeforeWriteRules(input.plan.plan).find(
    (candidate) =>
      candidate.targetPath === undefined ||
      normalizePlanPath(candidate.targetPath) === normalizePlanPath(attemptedPath)
  );
  if (!rule) return undefined;
  const normalizedReadPath = normalizePlanPath(rule.readPath);
  const alreadyRead = (input.session?.messages ?? []).some((message) =>
    messageShowsFileRead(message, normalizedReadPath)
  );
  if (alreadyRead) return undefined;
  return {
    requiredTool: "FileRead",
    requiredPath: rule.readPath,
    attemptedTool: input.toolUse.name,
    attemptedPath,
    message: [
      "Plan execution guard: attempted to modify a file before completing the inherited plan's read-before-write step.",
      `Required first: FileRead ${rule.readPath}`,
      `Attempted: ${input.toolUse.name} ${attemptedPath}`,
      "Read the required file, inspect the result, then retry the write/edit if it is still appropriate."
    ].join("\n")
  };
}

export function readBeforeWriteRules(plan: string): ReadBeforeWriteRule[] {
  const rules: ReadBeforeWriteRule[] = [];
  for (const line of plan.split(/\r?\n/)) {
    const match =
      /\bread\s+([^\s`'"]+|`[^`]+`|"[^"]+"|'[^']+')\s+before\s+(?:editing|writing|modifying|edit|write|modify)\b/i.exec(
        line
      );
    if (!match) continue;
    const readPath = stripPlanPathQuotes(match[1]);
    if (readPath) {
      rules.push({ readPath });
    }
  }
  const readThenWrite =
    /read\s+([^\s`'"]+|`[^`]+`|"[^"]+"|'[^']+')[\s\S]*?write\s+([^\s`'"]+|`[^`]+`|"[^"]+"|'[^']+')/i.exec(
      plan
    );
  if (readThenWrite) {
    const readPath = stripPlanPathQuotes(readThenWrite[1]);
    const targetPath = stripPlanPathQuotes(readThenWrite[2]);
    if (readPath && targetPath) {
      rules.push({ readPath, targetPath });
    }
  }
  return rules;
}

export function normalizePlanPath(filePath: string): string {
  return filePath
    .trim()
    .replace(/^\.\/+/, "")
    .replace(/\\/g, "/");
}

function mutableFilePath(toolUse: MagiToolUsePart): string | undefined {
  if (toolUse.name !== "FileWrite" && toolUse.name !== "FileEdit" && toolUse.name !== "FilePatch") {
    return undefined;
  }
  const raw = toolUse.input.file_path ?? toolUse.input.path;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function messageShowsFileRead(message: MessageRecord, normalizedPath: string): boolean {
  if (message.role === "tool" && message.metadata.toolName === "FileRead") {
    const content = message.content.replace(/\\/g, "/");
    return (
      content.includes(`Read ${normalizedPath} `) || content.includes(`Read ./${normalizedPath} `)
    );
  }
  if (message.role !== "assistant") return false;
  return false;
}

function stripPlanPathQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}
