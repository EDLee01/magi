import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sshFileRead, sshFileWrite } from "../src/ssh/file.js";

describe.skipIf(process.platform === "win32")("SSH file transfer", () => {
  let tmpDir: string | undefined;
  let previousPath: string | undefined;
  let previousFakeCwd: string | undefined;

  afterEach(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousFakeCwd === undefined) delete process.env.FAKE_SSH_CWD;
    else process.env.FAKE_SSH_CWD = previousFakeCwd;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function installFakeSsh(): string {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "magi-ssh-file-"));
    const binDir = path.join(tmpDir, "bin");
    require("node:fs").mkdirSync(binDir);
    const fakeSsh = path.join(binDir, "ssh");
    writeFileSync(
      fakeSsh,
      [
        "#!/usr/bin/env node",
        'const { readFileSync } = require("node:fs");',
        'const { spawnSync } = require("node:child_process");',
        "const command = process.argv.at(-1);",
        'const result = spawnSync("/bin/sh", ["-c", command], {',
        "  cwd: process.env.FAKE_SSH_CWD,",
        "  input: readFileSync(0),",
        '  encoding: "utf8"',
        "});",
        "if (result.stdout) process.stdout.write(result.stdout);",
        "if (result.stderr) process.stderr.write(result.stderr);",
        "process.exit(result.status ?? 1);",
        ""
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeSsh, 0o755);
    previousPath = process.env.PATH;
    previousFakeCwd = process.env.FAKE_SSH_CWD;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    process.env.FAKE_SSH_CWD = tmpDir;
    return tmpDir;
  }

  it("reads and writes quoted remote paths without shell expansion", async () => {
    const root = installFakeSsh();
    const remotePath = "remote-'$(touch injected).txt";
    writeFileSync(path.join(root, remotePath), "before\n", "utf8");

    const read = await sshFileRead({ host: "fake-host", path: remotePath });
    expect(read.content).toBe("before\n");
    expect(read.sizeBytes).toBe(Buffer.byteLength("before\n"));
    expect(existsSync(path.join(root, "injected"))).toBe(false);

    const content = "after 世界\n";
    const write = await sshFileWrite({
      host: "fake-host",
      path: remotePath,
      content
    });
    expect(write.sizeBytes).toBe(Buffer.byteLength(content));
    expect(readFileSync(path.join(root, remotePath), "utf8")).toBe(content);
    expect(existsSync(path.join(root, "injected"))).toBe(false);
  });
});
