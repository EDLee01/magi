import { execSync } from "node:child_process";

export interface WhichResult { name: string; path: string | null; exists: boolean }
export const WhichInputSchema = { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } satisfies Record<string, unknown>;

export function parseWhichInput(input: Record<string, unknown>): { name: string } {
  const name = typeof input.name === "string" ? input.name : "";
  if (!name) throw new Error("name is required");
  return { name };
}

export function executeWhich(input: { name: string }): WhichResult {
  try {
    const path = execSync(`which "${input.name.replace(/"/g, '\\"')}"`, { encoding: "utf8", timeout: 5000 }).trim();
    return { name: input.name, path: path || null, exists: path.length > 0 };
  } catch {
    return { name: input.name, path: null, exists: false };
  }
}

export function formatWhichResult(result: WhichResult): string {
  return result.exists ? `${result.name}: ${result.path}` : `${result.name}: not found`;
}
