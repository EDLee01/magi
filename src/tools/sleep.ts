import { ToolError } from "./errors.js";

export interface SleepInput {
  ms: number;
}

export const SleepInputSchema = {
  type: "object",
  properties: {
    ms: { type: "number", description: "Milliseconds to sleep (1-300000)" }
  },
  required: ["ms"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseSleepInput(input: Record<string, unknown>): SleepInput {
  const ms = input.ms;
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    throw new ToolError("Sleep ms must be a positive number", "bad-input");
  }
  if (ms > 300_000) {
    throw new ToolError(`Sleep ms must not exceed 300000 (5 minutes), got ${ms}`, "bad-input");
  }
  return { ms };
}

export async function executeSleep(input: SleepInput): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, input.ms));
  return `Slept for ${input.ms}ms`;
}
