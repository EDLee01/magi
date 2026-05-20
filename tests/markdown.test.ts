import { describe, expect, it } from "vitest";
import { createStreamingMarkdown, renderCodeBlock } from "../src/markdown.js";

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("streaming markdown renderer", () => {
  it("emits paragraphs as line-by-line", () => {
    const md = createStreamingMarkdown({ columns: 80 });
    const out = md.push("hello world\n");
    expect(stripAnsi(out)).toBe("hello world\n");
  });

  it("renders a header with a leading newline", () => {
    const md = createStreamingMarkdown({ columns: 80 });
    const out = md.push("# title\n");
    expect(stripAnsi(out)).toContain("title");
  });

  it("renders bold and italic inline", () => {
    const md = createStreamingMarkdown({ columns: 80 });
    const out = md.push("this is **bold** and *italic*\n");
    expect(out).toContain("\x1b[1m"); // bold ansi
    expect(out).toContain("\x1b[3m"); // italic ansi
  });

  it("renders a code block with box drawing", () => {
    const md = createStreamingMarkdown({ columns: 60, noHighlight: true });
    let out = md.push("```ts\n");
    out += md.push("const x = 1;\n");
    out += md.push("```\n");
    const text = stripAnsi(out);
    expect(text).toContain("ts");
    expect(text).toContain("│ const x = 1;");
    expect(text).toContain("╭");
    expect(text).toContain("╰");
  });

  it("highlights TypeScript keywords in code blocks when enabled", () => {
    const md = createStreamingMarkdown({ columns: 80 });
    let out = md.push("```ts\n");
    out += md.push("const foo = 42;\n");
    out += md.push("```\n");
    // Should contain the keyword color escape (38;5;141m for purple)
    expect(out).toContain("\x1b[38;5;141m");
    // And the number color (38;5;180m)
    expect(out).toContain("\x1b[38;5;180m");
  });

  it("renders an unordered list with bullets", () => {
    const md = createStreamingMarkdown({ columns: 80 });
    const out = md.push("- one\n- two\n");
    const text = stripAnsi(out);
    expect(text).toContain("• one");
    expect(text).toContain("• two");
  });

  it("renders an ordered list with numbers", () => {
    const md = createStreamingMarkdown({ columns: 80 });
    const out = md.push("1. first\n2. second\n");
    const text = stripAnsi(out);
    expect(text).toContain("1. first");
    expect(text).toContain("2. second");
  });

  it("renders a blockquote with vertical bar", () => {
    const md = createStreamingMarkdown({ columns: 80 });
    const out = md.push("> quoted text\n");
    expect(stripAnsi(out)).toContain("│ quoted text");
  });

  it("renders a markdown table with borders", () => {
    const md = createStreamingMarkdown({ columns: 80 });
    let out = md.push("| col1 | col2 |\n");
    out += md.push("| ---- | ---- |\n");
    out += md.push("| a    | b    |\n");
    out += md.push("\n"); // trigger flush via blank line
    const text = stripAnsi(out);
    expect(text).toContain("col1");
    expect(text).toContain("col2");
    expect(text).toContain("| a");
    expect(text).toContain("+");
  });

  it("renders inline code with background", () => {
    const md = createStreamingMarkdown({ columns: 80 });
    const out = md.push("call `someFunction()` here\n");
    // Background gray ansi
    expect(out).toContain("\x1b[48;5;236m");
  });

  it("renderCodeBlock width adapts to columns option", () => {
    const narrow = renderCodeBlock(["line1"], "ts", { columns: 30, noHighlight: true });
    const wide = renderCodeBlock(["line1"], "ts", { columns: 100, noHighlight: true });
    const narrowDashes = (stripAnsi(narrow).match(/─/g) ?? []).length;
    const wideDashes = (stripAnsi(wide).match(/─/g) ?? []).length;
    expect(wideDashes).toBeGreaterThan(narrowDashes);
  });

  it("flushes incomplete code block at end", () => {
    const md = createStreamingMarkdown({ columns: 60, noHighlight: true });
    md.push("```js\n");
    md.push("incomplete code");
    const flushed = md.flush();
    expect(stripAnsi(flushed)).toContain("incomplete code");
    expect(stripAnsi(flushed)).toContain("╰");
  });

  it("preserves regular text without markdown formatting", () => {
    const md = createStreamingMarkdown({ columns: 80 });
    const out = md.push("just a sentence with no markup\n");
    expect(stripAnsi(out)).toBe("just a sentence with no markup\n");
  });

  it("noHighlight flag disables syntax coloring", () => {
    const md = createStreamingMarkdown({ columns: 80, noHighlight: true });
    let out = md.push("```ts\n");
    out += md.push("const x = 1;\n");
    out += md.push("```\n");
    // Should NOT contain keyword color
    expect(out).not.toContain("\x1b[38;5;141m");
  });
});
