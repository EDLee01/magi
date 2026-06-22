import { spawnSync } from "node:child_process";

import { ToolError } from "./errors.js";

export interface WhichResult {
  name: string;
  path: string | null;
  exists: boolean;
}
export const WhichInputSchema = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseWhichInput(input: Record<string, unknown>): { name: string } {
  const name = typeof input.name === "string" ? input.name : "";
  if (!name) throw new ToolError("name is required", "bad-input");
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name)) {
    throw new ToolError(
      "name must be an executable name without paths or shell syntax",
      "bad-input"
    );
  }
  return { name };
}

export function executeWhich(input: { name: string }): WhichResult {
  const command = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(command, [input.name], {
    encoding: "utf8",
    timeout: 5000
  });
  if (result.error || result.status !== 0) {
    return { name: input.name, path: null, exists: false };
  }
  const resolvedPath = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return {
    name: input.name,
    path: resolvedPath ?? null,
    exists: resolvedPath !== undefined
  };
}

export function formatWhichResult(result: WhichResult): string {
  return result.exists ? `${result.name}: ${result.path}` : `${result.name}: not found`;
}
