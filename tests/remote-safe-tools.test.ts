import { describe, expect, it } from "vitest";

import { buildRemoteSafeToolRules } from "../src/tool-policy.js";
import { checkToolPermission } from "../src/tools/registry.js";

describe("remote safe tool rules", () => {
  const rules = buildRemoteSafeToolRules();

  it("denies FileDelete even in bypassPermissions mode", () => {
    const result = checkToolPermission({
      toolUse: {
        type: "tool-use",
        id: "del-1",
        name: "FileDelete",
        input: { path: "notes.txt" }
      },
      mode: "bypassPermissions",
      rules
    });
    expect(result.decision).toBe("deny");
  });

  it("allows FileWrite in bypassPermissions mode", () => {
    const result = checkToolPermission({
      toolUse: {
        type: "tool-use",
        id: "write-1",
        name: "FileWrite",
        input: { file_path: "notes.txt", content: "hello" }
      },
      mode: "bypassPermissions",
      rules
    });
    expect(result.decision).toBe("allow");
  });

  it("denies Bash rm commands", () => {
    const result = checkToolPermission({
      toolUse: {
        type: "tool-use",
        id: "bash-1",
        name: "Bash",
        input: { command: "rm -rf /tmp/example" }
      },
      mode: "bypassPermissions",
      rules
    });
    expect(result.decision).toBe("deny");
  });
});
