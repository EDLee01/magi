import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { getMagiPaths } from "../src/paths.js";
import { resolveRunnerCommand, RunnerClient } from "../src/runner/client.js";
import { SessionStore } from "../src/session-store.js";
import { makeTempRoot, TempRoot } from "./helpers.js";

const fixture = path.join(process.cwd(), "tests", "fixtures", "mock-runner.mjs");
let workspace: string | undefined;
let temp: TempRoot | undefined;

afterEach(() => {
  if (workspace) {
    rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
  }
  temp?.cleanup();
  temp = undefined;
});

describe("Rust runner bridge", () => {
  it("ships a magi-runner Rust crate skeleton", () => {
    const cargo = readFileSync(path.join(process.cwd(), "runner", "Cargo.toml"), "utf8");
    const main = readFileSync(path.join(process.cwd(), "runner", "src", "main.rs"), "utf8");

    expect(cargo).toContain('name = "magi-runner"');
    expect(cargo).toContain("publish = false");
    expect(main).toContain('"initialize"');
    expect(main).toContain('"ping"');
    expect(main).toContain('"echo"');
    expect(main).toContain('"process.run"');
    expect(main).toContain('"pty.smoke"');
    expect(main).toContain('"file.applyPatch"');
    expect(existsSync(path.join(process.cwd(), "runner", "src", "main.rs"))).toBe(true);
  });

  it("calls a runner over newline-delimited JSON-RPC", async () => {
    const client = new RunnerClient({
      command: { command: process.execPath, args: [fixture] },
      env: {}
    });
    try {
      const initialized = await client.initialize();
      expect(initialized).toEqual({
        runner: "magi-runner",
        version: "0.1.0-test",
        capabilities: ["ping", "echo", "process.run", "pty.smoke", "file.applyPatch"]
      });
      await expect(client.ping()).resolves.toEqual({ ok: true });
      await expect(client.echo("hello runner")).resolves.toBe("hello runner");
      await expect(
        client.runProcess({
          command: "printf ok",
          cwd: process.cwd()
        })
      ).resolves.toMatchObject({
        command: "printf ok",
        exitCode: 0,
        stdout: "mock stdout\n",
        timedOut: false
      });
      await expect(client.ptySmoke()).resolves.toMatchObject({ ok: true, stdout: "magi-pty-ok" });
      await expect(
        client.applyPatch({
          cwd: process.cwd(),
          filePath: "note.txt",
          content: "ok",
          approved: true
        })
      ).resolves.toMatchObject({
        path: "note.txt",
        approved: true,
        auditEvent: {
          action: "runner.file.applyPatch",
          target: "note.txt"
        }
      });
      await expect(
        client.applyPatch({
          cwd: process.cwd(),
          filePath: "note.txt",
          content: "ok",
          approved: false
        })
      ).rejects.toThrow(/approved=true/);
    } finally {
      client.close();
    }
  });

  it("supports runner ping from CLI with MAGI_* configuration", async () => {
    const result = await runCli(
      ["runner", "ping"],
      {
        MAGI_RUNNER_BIN: process.execPath,
        MAGI_RUNNER_ARGS: JSON.stringify([fixture])
      },
      process.cwd()
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("runner: magi-runner");
    expect(result.stdout).toContain("version: 0.1.0-test");
    expect(result.stdout).toContain("ok: true");
  });

  it("supports runner process and PTY commands from CLI", async () => {
    const env = {
      MAGI_RUNNER_BIN: process.execPath,
      MAGI_RUNNER_ARGS: JSON.stringify([fixture])
    };

    const run = await runCli(["runner", "run", "printf ok"], env, process.cwd());
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("command: printf ok");
    expect(run.stdout).toContain("stdout:\nmock stdout");

    const timedOut = await runCli(
      ["runner", "run", "sleep 10", "--timeout-ms", "1"],
      env,
      process.cwd()
    );
    expect(timedOut.exitCode).toBe(124);
    expect(timedOut.stdout).toContain("timedOut: true");

    const pty = await runCli(["runner", "pty-smoke"], env, process.cwd());
    expect(pty.exitCode).toBe(0);
    expect(pty.stdout).toContain("magi-pty-ok");
  });

  it("supports runner file apply from CLI and records audit events", async () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-runner-apply-"));
    const env = {
      ...temp.env,
      MAGI_RUNNER_BIN: process.execPath,
      MAGI_RUNNER_ARGS: JSON.stringify([fixture])
    };

    const rejected = await runCli(["runner", "apply", "note.txt", "ok"], env, workspace);
    expect(rejected.exitCode).toBe(2);
    expect(rejected.stderr).toContain("requires --approve");

    const applied = await runCli(
      ["runner", "apply", "note.txt", "ok", "--approve"],
      env,
      workspace
    );
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain("path: note.txt");
    expect(applied.stdout).toContain("sessionId:");
    expect(applied.stdout).toContain("+++ b/note.txt");

    const sessionId = /sessionId: ([^\n]+)/.exec(applied.stdout)?.[1];
    expect(sessionId).toBeTruthy();
    const store = SessionStore.open(getMagiPaths(env));
    try {
      const audit = store.listAuditEvents();
      expect(audit).toContainEqual(
        expect.objectContaining({
          sessionId,
          action: "runner.file.applyPatch",
          target: "note.txt"
        })
      );
    } finally {
      store.close();
    }
  });

  it("uses MAGI_RUNNER_* as runner configuration", () => {
    expect(
      resolveRunnerCommand({
        MAGI_RUNNER_BIN: "/tmp/magi-runner",
        MAGI_RUNNER_ARGS: JSON.stringify(["--stdio"])
      })
    ).toEqual({
      command: "/tmp/magi-runner",
      args: ["--stdio"]
    });
    expect(() => resolveRunnerCommand({ MAGI_RUNNER_ARGS: "--stdio" })).toThrow(
      /JSON string array/
    );
  });
});
