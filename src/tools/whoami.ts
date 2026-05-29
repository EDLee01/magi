import { execSync } from "node:child_process";
import os from "node:os";

export interface WhoAmIResult {
  user: string;
  home: string;
  shell: string;
  groups: string[];
  uid: number;
  gid: number;
}
export const WhoAmIInputSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false
} satisfies Record<string, unknown>;
export function parseWhoAmIInput(): Record<string, never> {
  return {};
}

export function executeWhoAmI(): WhoAmIResult {
  let groups: string[] = [];
  try {
    const raw = execSync("groups", { encoding: "utf8", timeout: 3000 });
    groups = raw.trim().split(/\s+/);
  } catch {
    /* best effort */
  }
  return {
    user: os.userInfo().username,
    home: os.userInfo().homedir,
    shell: os.userInfo().shell ?? "",
    groups,
    uid: os.userInfo().uid,
    gid: os.userInfo().gid
  };
}

export function formatWhoAmIResult(result: WhoAmIResult): string {
  return [
    `User:  ${result.user} (uid ${result.uid}, gid ${result.gid})`,
    `Home:  ${result.home}`,
    `Shell: ${result.shell}`,
    `Groups: ${result.groups.join(", ")}`
  ].join("\n");
}
