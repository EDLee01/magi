import { describe, expect, it } from "vitest";
import { PassThrough, Writable } from "node:stream";
import {
  buildPromptDisplayForTest,
  readTuiPrompt,
  shouldContinueOnEnterForTest,
  TuiPromptAbortError
} from "../src/tui/prompt-reader.js";

function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;?]*m/g, "").length;
}

function visibleCellWidth(text: string): number {
  return Array.from(text.replace(/\x1b\[[0-9;?]*m/g, "")).reduce((sum, ch) => {
    return (
      sum +
      (/[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(
        ch
      )
        ? 2
        : 1)
    );
  }, 0);
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*m/g, "");
}

function createPromptStreams(): { input: NodeJS.ReadStream; output: NodeJS.WriteStream } {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  input.isTTY = true;
  input.setRawMode = () => input;
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  }) as NodeJS.WriteStream;
  output.columns = 80;
  return { input, output };
}

describe("prompt reader display", () => {
  it("soft-wraps long input inside the safe terminal width", () => {
    const display = buildPromptDisplayForTest({
      prompt: "> ",
      text: "a".repeat(200),
      cursor: 200,
      safeColumns: 36,
      maxVisibleLines: 6
    });

    expect(display.lines.length).toBeGreaterThan(1);
    for (const line of display.lines) {
      expect(visibleLength(line)).toBeLessThanOrEqual(36);
    }
    expect(display.cursorColumn).toBeLessThan(36);
  });

  it("centers the viewport around the cursor in multiline input", () => {
    const text = ["one", "two", "three", "four", "five", "six"].join("\n");
    const cursor = text.indexOf("five") + 2;
    const display = buildPromptDisplayForTest({
      prompt: "> ",
      text,
      cursor,
      safeColumns: 40,
      maxVisibleLines: 3
    });

    expect(display.lines).toHaveLength(4);
    expect(display.lines.join("\n")).toContain("four");
    expect(display.lines.join("\n")).toContain("five");
    expect(display.cursorLine).toBe(1);
    expect(display.cursorColumn).toBeGreaterThan(0);
  });

  it("uses a continuation prompt for lines after the first line", () => {
    const display = buildPromptDisplayForTest({
      prompt: "> ",
      text: "alpha\nbeta",
      cursor: "alpha\nb".length,
      safeColumns: 40,
      maxVisibleLines: 6
    });

    expect(display.lines[0]).toContain("> alpha");
    expect(display.lines[1].replace(/\x1b\[[0-9;?]*m/g, "")).toContain("... beta");
  });

  it("places the cursor by terminal cell width for Chinese text", () => {
    const display = buildPromptDisplayForTest({
      prompt: "> ",
      text: "你好世界",
      cursor: "你好".length,
      safeColumns: 40,
      maxVisibleLines: 6
    });

    expect(display.cursorColumn).toBe(6);
  });

  it("keeps the cursor away from the physical terminal edge", () => {
    const display = buildPromptDisplayForTest({
      prompt: "> ",
      text: "x".repeat(120),
      cursor: 120,
      safeColumns: 34,
      maxVisibleLines: 6
    });

    expect(display.cursorColumn).toBeLessThan(33);
    expect(visibleCellWidth(display.lines[0])).toBeLessThanOrEqual(34);
  });

  it("does not clip a wide Chinese character past the safe width", () => {
    const display = buildPromptDisplayForTest({
      prompt: "> ",
      text: "a".repeat(20) + "你好世界".repeat(10),
      cursor: 20 + "你好世界".repeat(10).length,
      safeColumns: 35,
      maxVisibleLines: 6
    });

    expect(visibleCellWidth(display.lines[0])).toBeLessThanOrEqual(35);
    expect(display.cursorColumn).toBeLessThan(35);
  });

  it("places the cursor by grapheme width for emoji sequences", () => {
    const family = "👨‍👩‍👧‍👦";
    const display = buildPromptDisplayForTest({
      prompt: "> ",
      text: `a${family}b`,
      cursor: `a${family}`.length,
      safeColumns: 40,
      maxVisibleLines: 6
    });

    expect(display.cursorColumn).toBe(5);
  });

  it("does not split combining-character graphemes while soft wrapping", () => {
    const text = `Cafe\u0301 ${"好".repeat(20)}`;
    const display = buildPromptDisplayForTest({
      prompt: "> ",
      text,
      cursor: text.length,
      safeColumns: 24,
      maxVisibleLines: 6
    });

    expect(stripAnsi(display.lines.join(""))).toContain("Cafe\u0301");
    expect(display.cursorColumn).toBeLessThan(24);
  });

  it("does not drop wide characters at soft-wrap boundaries", () => {
    const prefix = "a".repeat(30);
    const text = prefix + "不懂世界";
    const display = buildPromptDisplayForTest({
      prompt: "> ",
      text,
      cursor: text.length,
      safeColumns: 36,
      maxVisibleLines: 8
    });
    const joined = stripAnsi(display.lines.join(""));

    expect(joined).toContain("不懂");
    expect(joined.replace(/\s+/g, "")).toContain("不懂世界");
  });

  it("does not show multiline helper text for soft-wrapped single-line input", () => {
    const text = "a".repeat(30) + "不懂世界";
    const display = buildPromptDisplayForTest({
      prompt: "> ",
      text,
      cursor: text.length,
      safeColumns: 36,
      maxVisibleLines: 6
    });
    const visible = stripAnsi(display.lines.join("\n"));

    expect(display.lines.length).toBeGreaterThan(1);
    expect(visible).not.toContain("lines, Enter submits");
  });

  it("keeps Enter in unfinished blocks and submits finished multiline text", () => {
    expect(shouldContinueOnEnterForTest("```ts\nconst x = 1")).toBe(true);
    expect(shouldContinueOnEnterForTest("```ts\nconst x = 1\n```")).toBe(false);
    expect(shouldContinueOnEnterForTest("call({ value: 1")).toBe(true);
    expect(shouldContinueOnEnterForTest("call({ value: 1 })")).toBe(false);
    expect(shouldContinueOnEnterForTest("first\nsecond")).toBe(false);
  });

  it("submits on Enter when the line ends with a paste placeholder", () => {
    expect(shouldContinueOnEnterForTest("Start audit: <<paste #1: 80 chars, 4 lines>>")).toBe(
      false
    );
  });

  it("shows slash command suggestions below slash input", () => {
    const commands = [
      { name: "model", usage: "/model [alias]", description: "Switch model alias" },
      { name: "memory", usage: "/memory", description: "Manage memory" },
      { name: "status", usage: "/status", description: "Show session status" }
    ];
    const display = buildPromptDisplayForTest({
      prompt: "> ",
      text: "/",
      cursor: 1,
      safeColumns: 64,
      maxVisibleLines: 6,
      slashCommands: commands
    });
    const visible = stripAnsi(display.lines.join("\n"));

    expect(visible).toContain("commands");
    expect(visible).toContain("/model");
    expect(visible).toContain("/memory");
    expect(visible).toContain("Tab complete");
    expect(visible).toContain("❯ /memory");
  });

  it("filters slash command suggestions by typed prefix", () => {
    const commands = [
      { name: "model", usage: "/model [alias]", description: "Switch model alias" },
      { name: "memory", usage: "/memory", description: "Manage memory" },
      { name: "status", usage: "/status", description: "Show session status" }
    ];
    const display = buildPromptDisplayForTest({
      prompt: "> ",
      text: "/mo",
      cursor: 3,
      safeColumns: 64,
      maxVisibleLines: 6,
      slashCommands: commands
    });
    const visible = stripAnsi(display.lines.join("\n"));

    expect(visible).toContain("commands matching /mo");
    expect(visible).toContain("/model");
    expect(visible).not.toContain("/memory");
  });

  it("does not show slash command suggestions for normal text", () => {
    const display = buildPromptDisplayForTest({
      prompt: "> ",
      text: "hello /status",
      cursor: "hello /status".length,
      safeColumns: 64,
      maxVisibleLines: 6,
      slashCommands: [{ name: "status", usage: "/status", description: "Show session status" }]
    });

    expect(stripAnsi(display.lines.join("\n"))).not.toContain("commands");
  });

  it("uses absolute column positioning and avoids forward-cursor escapes on submit", async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    input.isTTY = true;
    input.setRawMode = () => input;
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      }
    }) as NodeJS.WriteStream;
    output.columns = 80;

    const prompt = readTuiPrompt({ input, output, prompt: "> " });
    input.write("abc");
    input.write("\r");
    await expect(prompt).resolves.toBe("abc");

    const rendered = chunks.join("");
    expect(rendered).not.toMatch(/\x1b\[[0-9]+C/);
    expect(rendered).toMatch(/\x1b\[[0-9]+G/);
    expect(rendered).toContain("\x1b[J");
  });

  it("removes its temporary error listener after normal submit", async () => {
    const { input, output } = createPromptStreams();

    for (let index = 0; index < 12; index += 1) {
      const prompt = readTuiPrompt({ input, output, prompt: "> " });
      input.write(`hello ${index}\r`);
      await expect(prompt).resolves.toBe(`hello ${index}`);
      expect(input.listenerCount("error")).toBe(0);
    }
  });

  it("uses Ctrl+J/LF as a reliable newline key and Enter/CR as submit", async () => {
    const { input, output } = createPromptStreams();

    const prompt = readTuiPrompt({ input, output, prompt: "> " });
    input.write("first\nsecond\r");
    await expect(prompt).resolves.toBe("first\nsecond");
  });

  it("clears draft text on Escape and submits the next prompt", async () => {
    const { input, output } = createPromptStreams();

    const prompt = readTuiPrompt({ input, output, prompt: "> " });
    input.write("draft\x1bfinal\r");

    await expect(prompt).resolves.toBe("final");
  });

  it("aborts an empty prompt on Escape", async () => {
    const { input, output } = createPromptStreams();

    const prompt = readTuiPrompt({ input, output, prompt: "> " });
    input.write("\x1b");

    await expect(prompt).rejects.toMatchObject({
      reason: "ESC"
    } satisfies Partial<TuiPromptAbortError>);
  });

  it("submits the selected slash command with arrow keys and Enter", async () => {
    const { input, output } = createPromptStreams();
    const prompt = readTuiPrompt({
      input,
      output,
      prompt: "> ",
      slashCommands: [
        { name: "alpha", usage: "/alpha", description: "First command" },
        { name: "beta", usage: "/beta", description: "Second command" },
        { name: "gamma", usage: "/gamma", description: "Third command" }
      ]
    });

    input.write("/\x1b[B\r");

    await expect(prompt).resolves.toBe("/beta");
  });

  it("completes the selected slash command with Tab before submit", async () => {
    const { input, output } = createPromptStreams();
    const prompt = readTuiPrompt({
      input,
      output,
      prompt: "> ",
      slashCommands: [
        { name: "model", usage: "/model [alias]", description: "Switch model alias" },
        { name: "memory", usage: "/memory", description: "Manage memory" }
      ]
    });

    input.write("/mo\t\r");

    await expect(prompt).resolves.toBe("/model");
  });

  it("filters and submits slash command aliases", async () => {
    const { input, output } = createPromptStreams();
    const prompt = readTuiPrompt({
      input,
      output,
      prompt: "> ",
      slashCommands: [
        {
          name: "skill",
          aliases: ["skills"],
          usage: "/skills [name]",
          description: "List installed skills"
        },
        { name: "status", usage: "/status", description: "Show session status" }
      ]
    });

    input.write("/ski\r");

    await expect(prompt).resolves.toBe("/skills");
  });
});
