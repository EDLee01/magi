import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("capability manifest", () => {
  it("matches the package version and records required product boundaries", () => {
    const root = process.cwd();
    const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      version: string;
      files: string[];
    };
    const manifest = JSON.parse(
      readFileSync(path.join(root, "capability-manifest.json"), "utf8")
    ) as {
      version: string;
      capabilities: Array<{ id: string; status: string; details?: Record<string, unknown> }>;
    };
    const byId = new Map(manifest.capabilities.map((capability) => [capability.id, capability]));

    expect(manifest.version).toBe(packageJson.version);
    expect(packageJson.files).toContain("capability-manifest.json");
    expect([...byId.keys()]).toEqual(
      expect.arrayContaining([
        "agent-loop",
        "tool-registry",
        "subagents",
        "control-api",
        "tui",
        "rust-runner",
        "memory",
        "computer-use"
      ])
    );
    expect(byId.get("subagents")?.status).toBe("beta");
    expect(byId.get("control-api")?.status).toBe("beta");
    expect(byId.get("tui")?.status).toBe("partial");
    expect(byId.get("computer-use")?.status).toBe("excluded");
    expect(byId.get("rust-runner")?.details?.osSandboxEnforced).toBe(false);
  });
});
