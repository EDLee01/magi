import { ToolError } from "./errors.js";

export interface Base64Result {
  action: string;
  output: string;
}
export const Base64InputSchema = {
  type: "object",
  properties: { action: { type: "string", enum: ["encode", "decode"] }, text: { type: "string" } },
  required: ["action", "text"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseBase64Input(input: Record<string, unknown>): {
  action: "encode" | "decode";
  text: string;
} {
  const action = input.action === "decode" ? ("decode" as const) : ("encode" as const);
  const text = typeof input.text === "string" ? input.text : "";
  if (!text) throw new ToolError("text is required", "bad-input");
  return { action, text };
}

export function executeBase64(input: { action: "encode" | "decode"; text: string }): Base64Result {
  const output =
    input.action === "encode"
      ? Buffer.from(input.text, "utf8").toString("base64")
      : Buffer.from(input.text, "base64").toString("utf8");
  return { action: input.action, output };
}

export function formatBase64Result(result: Base64Result): string {
  return result.output;
}
