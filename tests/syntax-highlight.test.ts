import { describe, expect, it } from "vitest";
import { createHighlightState, highlightLine } from "../src/syntax-highlight.js";

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("syntax highlighter", () => {
  it("returns input unchanged for unknown language", () => {
    const state = createHighlightState();
    expect(highlightLine("foo bar baz", "unknown-lang", state)).toBe("foo bar baz");
  });

  it("returns input unchanged when language is undefined", () => {
    const state = createHighlightState();
    expect(highlightLine("foo bar", undefined, state)).toBe("foo bar");
  });

  it("colors TypeScript keywords", () => {
    const state = createHighlightState();
    const out = highlightLine("const x = 1;", "ts", state);
    expect(out).toContain("\x1b[38;5;141m"); // keyword color
    expect(stripAnsi(out)).toBe("const x = 1;");
  });

  it("colors string literals", () => {
    const state = createHighlightState();
    const out = highlightLine('let s = "hello";', "ts", state);
    expect(out).toContain("\x1b[38;5;108m"); // string color
  });

  it("colors line comments in JS/TS", () => {
    const state = createHighlightState();
    const out = highlightLine("const x = 1; // a note", "ts", state);
    expect(out).toContain("\x1b[38;5;243m"); // comment color
    expect(stripAnsi(out)).toContain("// a note");
  });

  it("colors numbers", () => {
    const state = createHighlightState();
    const out = highlightLine("const x = 42;", "ts", state);
    expect(out).toContain("\x1b[38;5;180m"); // number color
  });

  it("colors function call sites", () => {
    const state = createHighlightState();
    const out = highlightLine("doStuff(x);", "ts", state);
    expect(out).toContain("\x1b[38;5;111m"); // func color
  });

  it("handles Python comments and keywords", () => {
    const state = createHighlightState();
    const out = highlightLine("def foo():  # define", "py", state);
    expect(out).toContain("\x1b[38;5;141m"); // keyword (def)
    expect(out).toContain("\x1b[38;5;243m"); // comment (#)
  });

  it("tracks block comment state across lines", () => {
    const state = createHighlightState();
    const line1 = highlightLine("/* start", "ts", state);
    expect(state.inBlockComment).toBe(true);
    expect(line1).toContain("\x1b[38;5;243m");

    const line2 = highlightLine("still comment", "ts", state);
    expect(state.inBlockComment).toBe(true);
    expect(line2).toContain("\x1b[38;5;243m");

    const line3 = highlightLine("end */ const x = 1;", "ts", state);
    expect(state.inBlockComment).toBe(false);
    // Should color the comment AND the keyword
    expect(line3).toContain("\x1b[38;5;243m"); // comment portion
    expect(line3).toContain("\x1b[38;5;141m"); // const keyword after
  });

  it("highlights Rust keywords", () => {
    const state = createHighlightState();
    const out = highlightLine("fn main() { let x = 5; }", "rs", state);
    expect(out).toContain("\x1b[38;5;141m"); // fn / let
  });

  it("highlights shell keywords", () => {
    const state = createHighlightState();
    const out = highlightLine("if [ -f foo ]; then echo bar; fi", "sh", state);
    expect(out).toContain("\x1b[38;5;141m"); // if/then/fi/echo
  });

  it("preserves indentation", () => {
    const state = createHighlightState();
    const out = highlightLine("    const x = 1;", "ts", state);
    expect(stripAnsi(out)).toBe("    const x = 1;");
  });
});
