import { describe, expect, it, beforeEach } from "vitest";
import { isColorEnabled, setColorEnabled, stripAnsi, maybeStrip } from "../src/colors.js";

describe("colors", () => {
  beforeEach(() => {
    // Reset between tests; default in vitest forks is no-color (non-TTY).
    setColorEnabled(true);
  });

  it("stripAnsi removes SGR sequences", () => {
    expect(stripAnsi("\x1b[36mhello\x1b[39m")).toBe("hello");
  });

  it("stripAnsi removes cursor sequences", () => {
    expect(stripAnsi("\x1b[K\x1b[2A\x1b[?2004h")).toBe("");
  });

  it("stripAnsi leaves plain text unchanged", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });

  it("maybeStrip passes through when enabled", () => {
    setColorEnabled(true);
    expect(maybeStrip("\x1b[36mhi\x1b[39m")).toBe("\x1b[36mhi\x1b[39m");
  });

  it("maybeStrip strips when disabled", () => {
    setColorEnabled(false);
    expect(maybeStrip("\x1b[36mhi\x1b[39m")).toBe("hi");
  });

  it("setColorEnabled toggles isColorEnabled", () => {
    setColorEnabled(false);
    expect(isColorEnabled()).toBe(false);
    setColorEnabled(true);
    expect(isColorEnabled()).toBe(true);
  });
});
