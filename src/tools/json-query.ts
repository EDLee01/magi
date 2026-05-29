import { ToolError } from "./errors.js";

export interface JsonQueryResult {
  query: string;
  input: string;
  result: string;
}

export const JsonQueryInputSchema = {
  type: "object",
  properties: { json: { type: "string" }, path: { type: "string" } },
  required: ["json", "path"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseJsonQueryInput(input: Record<string, unknown>): {
  json: string;
  path: string;
} {
  const json = typeof input.json === "string" ? input.json : "";
  const path = typeof input.path === "string" ? input.path : "";
  if (!json) throw new ToolError("json is required", "bad-input");
  if (!path) throw new ToolError("path is required", "bad-input");
  return { json, path };
}

export function executeJsonQuery(input: { json: string; path: string }): JsonQueryResult {
  let data: unknown;
  try {
    data = JSON.parse(input.json);
  } catch {
    throw new ToolError("Invalid JSON input", "bad-input");
  }

  const result = queryJsonPath(data, input.path);
  return {
    query: input.path,
    input: input.json.length > 200 ? input.json.slice(0, 200) + "..." : input.json,
    result: JSON.stringify(result, null, 2)
  };
}

function queryJsonPath(data: unknown, path: string): unknown {
  // Support: "key", "key.subkey", "key[0]", "key[0].sub", "[].key"
  const parts = tokenize(path);
  let current = data;
  for (const part of parts) {
    if (current === undefined || current === null) return null;
    if (part.kind === "dot" || part.kind === "bracket") {
      if (typeof current === "object" && current !== null && !Array.isArray(current)) {
        current = (current as Record<string, unknown>)[part.value];
      } else if (Array.isArray(current) && part.value === "") {
        // [].key — array flatten
        current = current.map((item) =>
          typeof item === "object" && item
            ? (item as Record<string, unknown>)[part.value]
            : undefined
        );
      } else {
        return undefined;
      }
    } else if (part.kind === "index") {
      if (Array.isArray(current)) {
        const idx = part.value as number;
        current = current[idx];
      } else {
        return undefined;
      }
    }
  }
  return current;
}

function tokenize(
  path: string
): Array<{ kind: "dot" | "bracket" | "index"; value: string | number }> {
  const tokens: Array<{ kind: "dot" | "bracket" | "index"; value: string | number }> = [];
  const parts = path.split(".");
  for (const part of parts) {
    if (part === "") continue;
    const bracketMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (bracketMatch) {
      tokens.push({ kind: "dot", value: bracketMatch[1]! });
      tokens.push({ kind: "index", value: parseInt(bracketMatch[2]!, 10) });
    } else if (part.startsWith("[") && part.endsWith("]")) {
      const inner = part.slice(1, -1);
      if (inner === "") {
        tokens.push({ kind: "bracket", value: "" }); // [] wildcard
      } else if (/^\d+$/.test(inner)) {
        tokens.push({ kind: "index", value: parseInt(inner, 10) });
      } else {
        tokens.push({ kind: "bracket", value: inner.replace(/['"]/g, "") });
      }
    } else {
      tokens.push({ kind: "dot", value: part });
    }
  }
  return tokens;
}

export function formatJsonQueryResult(result: JsonQueryResult): string {
  return `${result.result}`;
}
