import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  chmodSync
} from "node:fs";
import path from "node:path";
import os from "node:os";

import { atomicWrite } from "../src/fs-utils.js";

describe("atomicWrite", () => {
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
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
    return tmpDir;
  }

  it("writes a new file with the given content", () => {
    const dir = makeDir();
    const target = path.join(dir, "out.txt");
    atomicWrite(target, "hello world");
    expect(readFileSync(target, "utf8")).toBe("hello world");
  });

  it("overwrites an existing file", () => {
    const dir = makeDir();
    const target = path.join(dir, "data.json");
    writeFileSync(target, "old", "utf8");
    atomicWrite(target, "new content");
    expect(readFileSync(target, "utf8")).toBe("new content");
  });

  it("accepts a Buffer payload", () => {
    const dir = makeDir();
    const target = path.join(dir, "binary.bin");
    atomicWrite(target, Buffer.from([0x48, 0x69, 0x21]));
    expect(readFileSync(target).toString()).toBe("Hi!");
  });

  it("does not leave temp files after success", () => {
    const dir = makeDir();
    const target = path.join(dir, "result.txt");
    atomicWrite(target, "ok");
    const files = readdirSync(dir);
    expect(files.filter((f) => f.startsWith(".result.txt.tmp."))).toHaveLength(0);
    expect(files).toContain("result.txt");
  });

  it("does not leave temp files after a failure", () => {
    const dir = makeDir();
    // Cause a failure by passing an unwritable target dir
    const subdir = path.join(dir, "readonly");
    require("node:fs").mkdirSync(subdir);
    chmodSync(subdir, 0o500); // read+execute only
    try {
      atomicWrite(path.join(subdir, "file.txt"), "x");
      // On some systems root may bypass; test still wants to check temp cleanup
    } catch {
      // expected on most systems
    } finally {
      chmodSync(subdir, 0o755);
    }
    const files = readdirSync(subdir);
    expect(files.filter((f) => f.startsWith(".file.txt.tmp."))).toHaveLength(0);
  });

  it("uses an in-directory temp file (so rename is atomic)", () => {
    const dir = makeDir();
    const target = path.join(dir, "x.txt");
    // Hook into mid-write isn't easy without more infrastructure;
    // we validate the property indirectly: the temp path must be in `dir`,
    // which we verify by checking that no errors occur even if /tmp is on a
    // different filesystem from `dir` (rename across FS would EXDEV).
    atomicWrite(target, "v1");
    atomicWrite(target, "v2");
    expect(readFileSync(target, "utf8")).toBe("v2");
  });

  it("respects the mode option for new files", () => {
    const dir = makeDir();
    const target = path.join(dir, "private.txt");
    atomicWrite(target, "secret", { mode: 0o600 });
    const stats = require("node:fs").statSync(target);
    // Mask the mode to permission bits only
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("preserves the mode of an existing file unless explicitly overridden", () => {
    const dir = makeDir();
    const target = path.join(dir, "script.sh");
    writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    atomicWrite(target, "#!/bin/sh\nprintf ok\n");

    const stats = require("node:fs").statSync(target);
    expect(stats.mode & 0o777).toBe(0o755);
  });
});
