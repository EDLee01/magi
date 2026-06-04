import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("clean-room compliance", () => {
  it("does not contain legacy runtime dependencies or forbidden implementation entries in production code", () => {
    const productionFiles = filesUnder(path.join(process.cwd(), "src"));
    const forbidden = [
      "/home/claude-user/magi",
      "Claude Web/OAuth",
      "Claude in Chrome",
      "Anthropic remote bridge",
      "official Claude plugin marketplace"
    ];

    for (const file of productionFiles) {
      const text = readFileSync(file, "utf8");
      for (const needle of forbidden) {
        expect(text, `${file} contains ${needle}`).not.toContain(needle);
      }
    }
  });

  it("does not publish magi-agent in package metadata", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8")
    ) as {
      name: string;
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    expect(packageJson.name).not.toBe("magi-agent");
    expect(packageJson.bin).toEqual({ magi: "dist/cli.js" });
    expect(Object.keys(packageJson.bin ?? {})).not.toContain("magi-agent");
    expect(JSON.stringify(packageJson.scripts ?? {})).not.toContain("magi-agent");
  });

  it("does not include copied legacy source-shaped files", () => {
    const files = filesUnder(process.cwd())
      .map((file) => path.relative(process.cwd(), file))
      .filter((file) => isRuntimeOrPackageFile(file));
    expect(files.some((file) => file.startsWith("src/") && file.includes("claude"))).toBe(false);
    expect(files.some((file) => file.includes("magi-agent"))).toBe(false);
  });
});

function filesUnder(root: string): string[] {
  const ignored = new Set(["node_modules", "dist", ".git"]);
  const entries: string[] = [];
  for (const name of readdirSync(root)) {
    if (ignored.has(name)) {
      continue;
    }
    const item = path.join(root, name);
    const stat = statSync(item);
    if (stat.isDirectory()) {
      entries.push(...filesUnder(item));
    } else {
      entries.push(item);
    }
  }
  return entries;
}

function isRuntimeOrPackageFile(file: string): boolean {
  return (
    file.startsWith("src/") ||
    file.startsWith("tests/") ||
    file === "package.json" ||
    file === "package-lock.json" ||
    file === "tsconfig.json" ||
    file === "tsconfig.build.json"
  );
}
