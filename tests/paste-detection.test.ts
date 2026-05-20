import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { collectPastedContinuations } from "../src/tui.js";

function makeEmitter(): EventEmitter & { emitLine: (line: string) => void } {
  const ee = new EventEmitter() as EventEmitter & { emitLine: (line: string) => void };
  ee.emitLine = (line: string) => ee.emit("line", line);
  return ee;
}

describe("collectPastedContinuations (paste detection)", () => {
  it("returns the first line alone when no continuations arrive", async () => {
    const ee = makeEmitter();
    const result = await collectPastedContinuations(ee, "hello", 20);
    expect(result).toBe("hello");
  });

  it("merges multiple lines that arrive within the window", async () => {
    const ee = makeEmitter();
    const promise = collectPastedContinuations(ee, "first", 80);
    setTimeout(() => ee.emitLine("second"), 10);
    setTimeout(() => ee.emitLine("third"), 30);
    setTimeout(() => ee.emitLine("fourth"), 50);
    const result = await promise;
    expect(result).toBe("first\nsecond\nthird\nfourth");
  });

  it("stops merging when a gap exceeds the window", async () => {
    const ee = makeEmitter();
    const promise = collectPastedContinuations(ee, "first", 30);
    setTimeout(() => ee.emitLine("second"), 10);
    // 100ms gap — should NOT be merged
    setTimeout(() => ee.emitLine("third"), 150);
    const result = await promise;
    expect(result).toBe("first\nsecond");
  });

  it("removes its line listener after completion", async () => {
    const ee = makeEmitter();
    const before = ee.listenerCount("line");
    await collectPastedContinuations(ee, "only", 10);
    const after = ee.listenerCount("line");
    expect(after).toBe(before);
  });

  it("handles empty first line", async () => {
    const ee = makeEmitter();
    const promise = collectPastedContinuations(ee, "", 30);
    setTimeout(() => ee.emitLine("real content"), 10);
    const result = await promise;
    expect(result).toBe("\nreal content");
  });

  it("preserves line ordering even when many lines arrive rapidly", async () => {
    const ee = makeEmitter();
    const promise = collectPastedContinuations(ee, "0", 80);
    for (let i = 1; i <= 5; i++) {
      setTimeout(() => ee.emitLine(String(i)), i * 5);
    }
    const result = await promise;
    expect(result).toBe("0\n1\n2\n3\n4\n5");
  });
});
