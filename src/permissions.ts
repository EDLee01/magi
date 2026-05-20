/**
 * Persistent permission rules.
 * Stores "always allow" rules to ~/.magi-next/permissions.json (or MAGI_CONFIG_DIR/permissions.json)
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { atomicWrite } from "./fs-utils.js";

export interface PermissionRule {
  /** Tool name pattern (exact match or "*") */
  tool: string;
  /** When the rule was created */
  createdAt: string;
  /** Optional description */
  description?: string;
}

function getPermissionsDir(): string {
  const configDir = process.env.MAGI_CONFIG_DIR
    ? path.resolve(process.env.MAGI_CONFIG_DIR)
    : path.join(os.homedir(), ".magi-next");
  return configDir;
}

const PERMISSIONS_FILE = path.join(getPermissionsDir(), "permissions.json");

let cachedRules: PermissionRule[] | undefined;

function loadRules(): PermissionRule[] {
  if (cachedRules) return cachedRules;
  if (!existsSync(PERMISSIONS_FILE)) {
    cachedRules = [];
    return cachedRules;
  }
  try {
    const raw = readFileSync(PERMISSIONS_FILE, "utf-8");
    cachedRules = JSON.parse(raw) as PermissionRule[];
    return cachedRules;
  } catch {
    cachedRules = [];
    return cachedRules;
  }
}

function saveRules(rules: PermissionRule[]): void {
  const permissionsDir = getPermissionsDir();
  if (!existsSync(permissionsDir)) {
    mkdirSync(permissionsDir, { recursive: true });
  }
  atomicWrite(PERMISSIONS_FILE, JSON.stringify(rules, null, 2));
  cachedRules = rules;
}

export function addPermissionRule(tool: string, description?: string): void {
  const rules = loadRules();
  // Don't duplicate
  if (rules.some((r) => r.tool === tool)) return;
  rules.push({
    tool,
    createdAt: new Date().toISOString(),
    description
  });
  saveRules(rules);
}

export function isToolAlwaysAllowed(toolName: string): boolean {
  const rules = loadRules();
  return rules.some((r) => r.tool === toolName || r.tool === "*");
}

export function listPermissionRules(): PermissionRule[] {
  return loadRules();
}

export function clearPermissionRules(): void {
  saveRules([]);
}

export function removePermissionRule(tool: string): boolean {
  const rules = loadRules();
  const filtered = rules.filter((r) => r.tool !== tool);
  if (filtered.length === rules.length) return false;
  saveRules(filtered);
  return true;
}
