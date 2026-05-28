import { describe, expect, it } from "vitest";
import { registry } from "../src/commands/registry.js";
import "../src/commands/register-all.js";
import { registerAllCommands } from "../src/commands/register-all.js";

// Make sure commands are registered
registerAllCommands();

describe("typo suggestion", () => {
  it("returns the same name for an exact match", () => {
    expect(registry.suggestCommand("help")).toBe("help");
    expect(registry.suggestCommand("status")).toBe("status");
  });

  it("returns a single-edit suggestion for short typos", () => {
    expect(registry.suggestCommand("helpp")).toBe("help");
    expect(registry.suggestCommand("statu")).toBe("status");
    expect(registry.suggestCommand("modle")).toBe("model");
  });

  it("handles transpositions and missing letters", () => {
    expect(registry.suggestCommand("memry")).toBe("memory");
    expect(registry.suggestCommand("sesions")).toBe("sessions");
  });

  it("returns prefix matches early", () => {
    // 'sta' should suggest 'status' via prefix path
    expect(registry.suggestCommand("sta")).toBe("status");
  });

  it("respects the strictness threshold for very different names", () => {
    expect(registry.suggestCommand("xyzzy")).toBeUndefined();
    expect(registry.suggestCommand("totally-not-a-command")).toBeUndefined();
  });

  it("strips a leading slash", () => {
    expect(registry.suggestCommand("/helpp")).toBe("help");
  });

  it("returns undefined for empty input", () => {
    expect(registry.suggestCommand("")).toBeUndefined();
    expect(registry.suggestCommand("/")).toBeUndefined();
  });

  it("considers aliases (e.g. img -> image)", () => {
    // 'imag' should suggest 'image' (or 'img' alias) via prefix
    const suggestion = registry.suggestCommand("imag");
    expect(["image", "img"]).toContain(suggestion);
  });

  it("registers the goal slash command", () => {
    expect(registry.get("goal")?.usage).toContain("/goal");
  });
});
