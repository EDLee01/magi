import { describe, expect, it } from "vitest";
import { PassThrough, Writable } from "node:stream";

import { showTuiPicker } from "../src/tui/picker.js";

function createPickerStreams(): {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  chunks: string[];
  rawModes: boolean[];
} {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  input.isTTY = true;
  const rawModes: boolean[] = [];
  input.setRawMode = (mode: boolean) => {
    input.isRaw = mode;
    rawModes.push(mode);
    return input;
  };
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    }
  }) as NodeJS.WriteStream;
  output.columns = 80;
  return { input, output, chunks, rawModes };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

describe("TUI picker", () => {
  it("selects an item with arrow keys and Enter", async () => {
    const { input, output } = createPickerStreams();
    const picker = showTuiPicker({
      stdin: input,
      stdout: output,
      title: "models",
      items: [
        { label: "fast", value: "fast", description: "gpt-fast" },
        { label: "main", value: "main", description: "gpt-main" },
        { label: "slow", value: "slow", description: "gpt-slow" }
      ]
    });

    input.write("\x1b[B\r");

    await expect(picker).resolves.toBe("main");
  });

  it("filters items before selection", async () => {
    const { input, output, chunks } = createPickerStreams();
    const picker = showTuiPicker({
      stdin: input,
      stdout: output,
      title: "resume sessions",
      items: [
        { label: "build tui", value: "session-a", description: "3 msg" },
        { label: "write docs", value: "session-b", description: "5 msg" }
      ]
    });

    input.write("docs\r");

    await expect(picker).resolves.toBe("session-b");
    expect(stripAnsi(chunks.join(""))).toContain("matching docs");
  });

  it("uses Tab to complete the selected item", async () => {
    const { input, output } = createPickerStreams();
    const picker = showTuiPicker({
      stdin: input,
      stdout: output,
      title: "models",
      items: [
        { label: "memory", value: "memory" },
        { label: "model", value: "model" }
      ]
    });

    input.write("mo\t\r");

    await expect(picker).resolves.toBe("model");
  });

  it("returns undefined on Escape", async () => {
    const { input, output } = createPickerStreams();
    const picker = showTuiPicker({
      stdin: input,
      stdout: output,
      title: "models",
      items: [{ label: "main", value: "main" }]
    });

    input.write("\x1b");

    await expect(picker).resolves.toBeUndefined();
  });

  it("renders multiline item fields as a single physical row", async () => {
    const { input, output, chunks } = createPickerStreams();
    const picker = showTuiPicker({
      stdin: input,
      stdout: output,
      title: "resume sessions",
      items: [
        {
          label: "Dear Miss Zheng:\n\nThe Editor of the IEEE Journal",
          value: "letter-session",
          description: "8 msg",
          detail: "2026-05-25T15:27:06.188Z\n/Users/ktz"
        }
      ]
    });

    input.write("\x1b");

    await expect(picker).resolves.toBeUndefined();
    const visible = stripAnsi(chunks.join(""));
    expect(visible).toContain("Dear Miss Zheng: The Editor");
    expect(visible).not.toContain("Dear Miss Zheng:\n\nThe Editor");
    expect(visible).not.toContain("2026-05-25T15:27:06.188Z\n/Users/ktz");
  });

  it("keeps scroll position visible before clipping long detail", async () => {
    const { input, output, chunks } = createPickerStreams();
    output.columns = 56;
    const picker = showTuiPicker({
      stdin: input,
      stdout: output,
      title: "resume sessions",
      items: Array.from({ length: 12 }, (_, index) => ({
        label: `visual resume session ${index}`,
        value: `session-${index}`,
        description: "2 msg",
        detail: `/Users/ktz/projects/magi-next/packages/client/${index}/deeply-nested-workspace`
      })),
      maxVisibleItems: 10
    });

    input.write("\r");

    await expect(picker).resolves.toBe("session-0");
    const visible = stripAnsi(chunks.join(""));
    expect(visible).toContain("1/12");
    expect(visible).toContain("…");
  });

  it("cleans up input state when cancelled by an abort signal", async () => {
    const { input, output, rawModes } = createPickerStreams();
    const controller = new AbortController();
    const picker = showTuiPicker({
      stdin: input,
      stdout: output,
      title: "approval required",
      items: [{ label: "Deny", value: "deny" }],
      cancelValue: "deny",
      signal: controller.signal
    });

    expect(input.listenerCount("data")).toBe(1);
    controller.abort();

    await expect(picker).resolves.toBe("deny");
    expect(input.listenerCount("data")).toBe(0);
    expect(rawModes).toEqual([true, false]);
  });
});
