import { MagiToolDefinition, MagiToolUsePart } from "./providers/ir.js";
import type { ToolPermissionResult, ToolPermissionRules } from "./tools/registry.js";
import { commandAllowedByPrefix } from "./tools/shell.js";

export interface ToolPolicyInput {
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
}

const TOOL_ALIASES: Record<string, string[]> = {
  Read: ["FileRead", "NotebookRead", "ListMcpResources", "ReadMcpResource"],
  Search: ["Glob", "Grep", "ToolSearch", "WorkspaceDiagnostics", "SessionSearch"],
  Edit: ["FileEdit", "FilePatch", "NotebookEdit"],
  Write: ["FileWrite", "FileEdit", "FilePatch", "NotebookEdit"],
  Bash: ["Bash"]
};

/** Deny delete-style tools while keeping yolo/bypassPermissions for read/write. */
export const REMOTE_SAFE_DENY_TOOLS = [
  "FileDelete",
  "GitBranchDelete",
  "GitReset",
  "CronDelete",
  "KillProcess",
  "Bash(rm*)",
  "Bash(* rm *)",
  "Bash(trash*)",
  "Bash(*unlink*)",
  "Bash(*rmdir*)"
] as const;

export function buildRemoteSafeToolRules(): ToolPermissionRules {
  return buildToolPermissionRules({ disallowedTools: [...REMOTE_SAFE_DENY_TOOLS] })!;
}

export function buildToolPermissionRules(input: ToolPolicyInput): ToolPermissionRules | undefined {
  const allow = [
    ...expandToolPolicyEntries(input.tools ?? [], "allow"),
    ...expandToolPolicyEntries(input.allowedTools ?? [], "allow")
  ];
  const deny = expandToolPolicyEntries(input.disallowedTools ?? [], "deny");
  if (allow.length === 0 && deny.length === 0) {
    return undefined;
  }
  return { allow, ask: [], deny };
}

export function filterToolDefinitionsByRules(
  definitions: MagiToolDefinition[],
  rules: ToolPermissionRules | undefined
): MagiToolDefinition[] {
  return filterNamedToolRecordsByRules(definitions, rules);
}

export function filterNamedToolRecordsByRules<T extends { name: string }>(
  records: T[],
  rules: ToolPermissionRules | undefined
): T[] {
  if (!rules) return records;
  return records.filter((record) => {
    if (hasExactToolPolicyRule(record.name, rules.deny)) return false;
    if (rules.allow.length === 0) return true;
    return hasToolPolicyRule(record.name, rules.allow);
  });
}

export function checkToolPolicy(
  toolUse: MagiToolUsePart,
  rules: ToolPermissionRules | undefined
): ToolPermissionResult | undefined {
  if (!rules) return undefined;
  const denied = matchingToolPolicyRule(toolUse, rules.deny, "deny");
  if (denied) {
    return { decision: "deny", reason: `matched rule ${denied}` };
  }
  if (rules.allow.length > 0) {
    const allowed = matchingToolPolicyRule(toolUse, rules.allow, "allow");
    if (!allowed) {
      return { decision: "deny", reason: `${toolUse.name} is not in allowed tools` };
    }
    return { decision: "allow", reason: `matched rule ${allowed}` };
  }
  return undefined;
}

export function parseToolPolicyList(value: string | undefined, label: string): string[] {
  if (!value) {
    throw new Error(`${label} requires a comma-separated tool list`);
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function expandToolPolicyEntries(entries: string[], decision: "allow" | "deny"): string[] {
  const expanded: string[] = [];
  for (const entry of entries) {
    const normalized = normalizeToolPolicyEntry(entry);
    const parsed = parsePolicyRule(normalized);
    const aliases = TOOL_ALIASES[parsed.name] ?? [parsed.name];
    for (const name of aliases) {
      expanded.push(`${name}(${parsed.selector})`);
    }
  }
  return decision === "deny" ? Array.from(new Set(expanded)) : expanded;
}

function normalizeToolPolicyEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) return "";
  return /^[A-Za-z0-9_]+\(.+\)$/.test(trimmed) ? trimmed : `${trimmed}(*)`;
}

function matchingToolPolicyRule(
  toolUse: MagiToolUsePart,
  rules: string[],
  mode: "allow" | "deny"
): string | undefined {
  return rules.find((rule) => {
    const parsed = parsePolicyRule(rule);
    if (parsed.name !== toolUse.name) return false;
    return selectorMatches(parsed.selector, toolPolicyHaystack(toolUse.input), mode);
  });
}

function matchesToolPolicyRules(
  toolName: string,
  input: Record<string, unknown>,
  rules: string[],
  mode: "allow" | "deny"
): boolean {
  return rules.some((rule) => {
    const parsed = parsePolicyRule(rule);
    if (parsed.name !== toolName) return false;
    return (
      parsed.selector === "*" || selectorMatches(parsed.selector, toolPolicyHaystack(input), mode)
    );
  });
}

function hasExactToolPolicyRule(toolName: string, rules: string[]): boolean {
  return rules.some((rule) => {
    const parsed = parsePolicyRule(rule);
    return parsed.name === toolName && parsed.selector === "*";
  });
}

function hasToolPolicyRule(toolName: string, rules: string[]): boolean {
  return rules.some((rule) => parsePolicyRule(rule).name === toolName);
}

function parsePolicyRule(rule: string): { name: string; selector: string } {
  const parsed = /^([A-Za-z0-9_]+)\((.*)\)$/.exec(rule.trim());
  if (!parsed) {
    return { name: rule.trim(), selector: "*" };
  }
  return { name: parsed[1], selector: parsed[2] || "*" };
}

function selectorMatches(selector: string, value: string, mode: "allow" | "deny"): boolean {
  if (selector === "*") return true;
  if (/^[A-Za-z0-9_-]+:\*$/.test(selector)) {
    const command = selector.slice(0, -2);
    if (mode === "allow") {
      // Allow rules must not be satisfiable by chaining a second command past
      // the prefix (e.g. `git log && rm -rf /` against Bash(git:*)).
      return commandAllowedByPrefix(value, command);
    }
    // Deny rules keep loose prefix matching so a denied command still matches
    // even when it chains further operators.
    return value === command || value.startsWith(`${command} `);
  }
  const regex = new RegExp(`^${selector.split("*").map(escapeRegExp).join(".*")}$`);
  return regex.test(value);
}

function toolPolicyHaystack(input: Record<string, unknown>): string {
  return String(input.command ?? input.file_path ?? input.pattern ?? input.url ?? "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
