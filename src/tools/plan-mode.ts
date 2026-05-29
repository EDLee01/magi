/**
 * Planning mode tools: EnterPlanMode and ExitPlanMode.
 *
 * EnterPlanMode switches the agent into a read-only exploration mode where
 * mutations are blocked. The agent explores the codebase and designs a plan.
 *
 * ExitPlanMode signals that the plan is ready for user approval.
 * The plan content is returned to the user for review.
 */

export interface PlanModeState {
  active: boolean;
  planContent?: string;
  enteredAt?: string;
}

export const EnterPlanModeInputSchema = {
  type: "object",
  properties: {
    reason: { type: "string", description: "Why planning is needed before implementation" }
  },
  required: [],
  additionalProperties: false
} satisfies Record<string, unknown>;

export const ExitPlanModeInputSchema = {
  type: "object",
  properties: {
    plan: { type: "string", description: "The implementation plan for user approval" }
  },
  required: ["plan"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseEnterPlanModeInput(input: Record<string, unknown>): { reason?: string } {
  return {
    reason: typeof input.reason === "string" ? input.reason.trim() || undefined : undefined
  };
}

export function parseExitPlanModeInput(input: Record<string, unknown>): { plan: string } {
  const plan = input.plan;
  if (typeof plan !== "string" || !plan.trim()) {
    throw new Error("ExitPlanMode requires a non-empty plan");
  }
  return { plan: plan.trim() };
}

export function formatEnterPlanModeResult(input: { reason?: string }): string {
  return [
    "Entered plan mode. Mutations are blocked until the plan is approved.",
    "Use read-only tools (FileRead, Grep, Glob, GitLog, etc.) to explore the codebase.",
    "When ready, call ExitPlanMode with your implementation plan.",
    input.reason ? `\nReason: ${input.reason}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatExitPlanModeResult(input: { plan: string; id?: string }): string {
  return [
    "Plan submitted for user approval.",
    input.id ? `Plan id: ${input.id}` : undefined,
    "",
    "---",
    input.plan,
    "---",
    "",
    "Waiting for user to approve or provide feedback."
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
