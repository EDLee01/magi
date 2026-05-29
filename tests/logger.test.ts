import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import os from "node:os";

import { createJsonLogger } from "../src/logger.js";

describe("createJsonLogger", () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
      tmpDir = undefined;
    }
  });

  function makeDir(): string {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "logger-"));
    return tmpDir;
  }

  it("writes one JSON entry per line at info level by default", () => {
    const dir = makeDir();
    const file = path.join(dir, "test.log");
    const log = createJsonLogger({ filePath: file });
    log.info("hello", { foo: 42 });
    log.warn("careful");
    log.close();
    const content = readFileSync(file, "utf8").trim();
    const lines = content.split("\n");
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0]);
    expect(a.msg).toBe("hello");
    expect(a.level).toBe("info");
    expect(a.ctx).toEqual({ foo: 42 });
    expect(typeof a.ts).toBe("string");
    const b = JSON.parse(lines[1]);
    expect(b.level).toBe("warn");
  });

  it("respects the level threshold", () => {
    const dir = makeDir();
    const file = path.join(dir, "warn.log");
    const log = createJsonLogger({ filePath: file, level: "warn" });
    log.debug("not written");
    log.info("not written either");
    log.warn("yes");
    log.error("yes");
    log.close();
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).level).toBe("warn");
    expect(JSON.parse(lines[1]).level).toBe("error");
  });

  it("appends to an existing file", () => {
    const dir = makeDir();
    const file = path.join(dir, "append.log");
    writeFileSync(file, '{"existing":"line"}\n', "utf8");
    const log = createJsonLogger({ filePath: file });
    log.info("new entry");
    log.close();
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).msg).toBe("new entry");
  });

  it("rotates when the file exceeds maxBytes", () => {
    const dir = makeDir();
    const file = path.join(dir, "rot.log");
    const log = createJsonLogger({ filePath: file, maxBytes: 200, maxFiles: 3 });
    // Each entry is ~80-100 bytes; 5 entries should trigger one rotation
    for (let i = 0; i < 5; i++) {
      log.info("entry", { i, padding: "x".repeat(50) });
    }
    log.close();
    const files = readdirSync(dir).sort();
    expect(files).toContain("rot.log");
    expect(files).toContain("rot.log.1");
    // Active file should be much smaller than total
    expect(statSync(file).size).toBeLessThan(300);
  });

  it("caps rotated file count at maxFiles", () => {
    const dir = makeDir();
    const file = path.join(dir, "cap.log");
    const log = createJsonLogger({ filePath: file, maxBytes: 100, maxFiles: 2 });
    for (let i = 0; i < 12; i++) {
      log.info("x", { i, padding: "y".repeat(80) });
    }
    log.close();
    const files = readdirSync(dir);
    // Should have cap.log + cap.log.1 + cap.log.2 (no .3+)
    const rotated = files.filter((f) => f.startsWith("cap.log."));
    expect(rotated.length).toBeLessThanOrEqual(2);
  });

  it("does not crash if filePath's parent does not exist (creates it)", () => {
    const dir = makeDir();
    const nested = path.join(dir, "deep", "nested", "x.log");
    const log = createJsonLogger({ filePath: nested });
    log.info("ok");
    log.close();
    expect(existsSync(nested)).toBe(true);
  });

  it("swallows errors so logging never throws", () => {
    const dir = makeDir();
    const file = path.join(dir, "x.log");
    const log = createJsonLogger({ filePath: file });
    // Force an unsupported circular reference in ctx
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(() => log.info("ok", obj)).not.toThrow();
    log.close();
  });
});
