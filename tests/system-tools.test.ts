import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { executeDiskUsage } from "../src/tools/disk-usage.js";
import { executeKillProcess } from "../src/tools/kill-process.js";
import { executeProcessList } from "../src/tools/process-list.js";
import { executeWhich, parseWhichInput } from "../src/tools/which.js";

describe("system tools", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function makeSentinel(): string {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "magi-system-tools-"));
    return path.join(tmpDir, "injected");
  }

  it("passes DiskUsage paths as argv without shell expansion", () => {
    const sentinel = makeSentinel();

    expect(() =>
      executeDiskUsage({
        path: `$(touch ${sentinel})`,
        humanReadable: true
      })
    ).toThrow();
    expect(existsSync(sentinel)).toBe(false);
  });

  it("rejects shell syntax in Which executable names", () => {
    const sentinel = makeSentinel();

    expect(() => parseWhichInput({ name: `$(touch ${sentinel})` })).toThrow(/executable name/);
    expect(existsSync(sentinel)).toBe(false);
    expect(executeWhich({ name: "node" })).toMatchObject({ name: "node", exists: true });
  });

  it("filters ProcessList in memory instead of interpolating a shell pipeline", () => {
    const sentinel = makeSentinel();

    executeProcessList({
      filter: `$(touch ${sentinel})`,
      sortBy: "cpu",
      limit: 5
    });

    expect(existsSync(sentinel)).toBe(false);
  });

  it("does not evaluate shell syntax in KillProcess names", () => {
    const sentinel = makeSentinel();

    expect(() =>
      executeKillProcess({
        name: `$(touch ${sentinel})`,
        signal: "SIGTERM"
      })
    ).toThrow(/No processes found/);
    expect(existsSync(sentinel)).toBe(false);
  });
});
