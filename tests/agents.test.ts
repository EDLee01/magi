import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { ensureMagiHome, getMagiPaths } from "../src/paths.js";
import {
  cancelAgentTask,
  completeAgentTask,
  spawnAgentTask,
  startAgentTask,
  waitAgentTask
} from "../src/agents/task-queue.js";
import { SessionStore } from "../src/session-store.js";
import { makeTempRoot, TempRoot } from "./helpers.js";

let temp: TempRoot | undefined;
let workspace: string | undefined;

afterEach(() => {
  temp?.cleanup();
  temp = undefined;
  if (workspace) {
    rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
  }
});

describe("multi-agent task queue", () => {
  it("spawns explorer and worker tasks and transitions status", () => {
    temp = makeTempRoot();
    workspace = realpathSync(mkdtempSync(path.join(os.tmpdir(), "magi-agents-")));
    const store = SessionStore.open(getMagiPaths(temp.env));
    try {
      const explorer = spawnAgentTask(store, {
        role: "explorer",
        prompt: "inspect",
        cwd: workspace
      });
      expect(explorer.status).toBe("queued");
      expect(startAgentTask(store, explorer.id).status).toBe("running");
      expect(completeAgentTask(store, explorer.id, "done").status).toBe("completed");
      expect(waitAgentTask(store, explorer.id).result).toBe("done");

      const worker = spawnAgentTask(store, {
        role: "worker",
        prompt: "edit file",
        cwd: workspace,
        writeFiles: ["src/a.ts"]
      });
      expect(worker.role).toBe("worker");
      expect(store.listWriteClaims()).toMatchObject([{ taskId: worker.id, filePath: "src/a.ts" }]);
      expect(cancelAgentTask(store, worker.id).status).toBe("cancelled");
    } finally {
      store.close();
    }
  });

  it("rejects explorer write ownership and detects same-file conflicts", () => {
    temp = makeTempRoot();
    workspace = realpathSync(mkdtempSync(path.join(os.tmpdir(), "magi-agents-")));
    const store = SessionStore.open(getMagiPaths(temp.env));
    try {
      expect(() =>
        spawnAgentTask(store, {
          role: "explorer",
          prompt: "inspect",
          cwd: workspace!,
          writeFiles: ["a.txt"]
        })
      ).toThrow(/cannot claim write files/);

      spawnAgentTask(store, {
        role: "worker",
        prompt: "one",
        cwd: workspace,
        writeFiles: ["a.txt"]
      });
      expect(() =>
        spawnAgentTask(store, {
          role: "worker",
          prompt: "two",
          cwd: workspace!,
          writeFiles: ["a.txt"]
        })
      ).toThrow(/Write conflict/);
      expect(store.listAgentTasks()).toHaveLength(1);
      expect(store.listWriteClaims()).toMatchObject([{ filePath: "a.txt" }]);
    } finally {
      store.close();
    }
  });

  it("supports agent queue commands from CLI", async () => {
    temp = makeTempRoot();
    workspace = realpathSync(mkdtempSync(path.join(os.tmpdir(), "magi-agents-")));

    const spawned = await runCli(
      ["agents", "spawn", "worker", "edit file", "--write-file", "a.txt"],
      temp.env,
      workspace
    );
    expect(spawned.exitCode).toBe(0);
    const task = JSON.parse(spawned.stdout) as { id: string; status: string };
    expect(task.status).toBe("queued");

    const started = await runCli(["agents", "start", task.id], temp.env, workspace);
    expect(JSON.parse(started.stdout).status).toBe("running");

    const completed = await runCli(["agents", "complete", task.id, "done"], temp.env, workspace);
    expect(JSON.parse(completed.stdout).status).toBe("completed");

    const list = await runCli(["agents", "list"], temp.env, workspace);
    expect(list.stdout).toContain(task.id);
  });

  it("triggers notification and stop hooks from CLI agent commands", async () => {
    temp = makeTempRoot();
    workspace = realpathSync(mkdtempSync(path.join(os.tmpdir(), "magi-agents-")));
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      [
        "version: 0.1",
        "hooks:",
        "  - event: task_created",
        "    type: command",
        '    command: "node -e \'require(\\"fs\\").writeFileSync(\\"task-created-cli.json\\", process.env.ARGUMENTS)\'"',
        "  - event: subagent_start",
        "    type: command",
        "    if: agentType:worker",
        '    command: "node -e \'require(\\"fs\\").writeFileSync(\\"subagent-start-cli.json\\", process.env.ARGUMENTS)\'"',
        "  - event: task_completed",
        "    type: command",
        '    command: "node -e \'require(\\"fs\\").writeFileSync(\\"task-completed-cli.json\\", process.env.ARGUMENTS)\'"',
        "  - event: subagent_stop",
        "    type: command",
        '    command: "node -e \'require(\\"fs\\").writeFileSync(\\"subagent-stop-cli.json\\", process.env.ARGUMENTS)\'"',
        "  - event: notification",
        "    type: command",
        '    command: "node -e \'require(\\"fs\\").writeFileSync(\\"notify-cli.json\\", process.env.ARGUMENTS)\'"',
        "  - event: stop",
        "    type: command",
        '    command: "node -e \'require(\\"fs\\").writeFileSync(\\"stop-cli.json\\", process.env.ARGUMENTS)\'"',
        ""
      ].join("\n"),
      "utf8"
    );

    const completedSpawn = await runCli(
      ["agents", "spawn", "worker", "complete me"],
      temp.env,
      workspace
    );
    const completedTask = JSON.parse(completedSpawn.stdout) as { id: string };
    await expect(
      readFile(path.join(workspace, "task-created-cli.json"), "utf8")
    ).resolves.toContain("complete me");
    const started = await runCli(["agents", "start", completedTask.id], temp.env, workspace);
    expect(JSON.parse(started.stdout).status).toBe("running");
    await expect(
      readFile(path.join(workspace, "subagent-start-cli.json"), "utf8")
    ).resolves.toContain("worker");
    const completed = await runCli(
      ["agents", "complete", completedTask.id, "done"],
      temp.env,
      workspace
    );
    expect(JSON.parse(completed.stdout).status).toBe("completed");
    await expect(readFile(path.join(workspace, "notify-cli.json"), "utf8")).resolves.toContain(
      "agent_task_completed"
    );
    await expect(
      readFile(path.join(workspace, "task-completed-cli.json"), "utf8")
    ).resolves.toContain(completedTask.id);
    await expect(
      readFile(path.join(workspace, "subagent-stop-cli.json"), "utf8")
    ).resolves.toContain(completedTask.id);

    const cancelledSpawn = await runCli(
      ["agents", "spawn", "worker", "cancel me"],
      temp.env,
      workspace
    );
    const cancelledTask = JSON.parse(cancelledSpawn.stdout) as { id: string };
    const cancelled = await runCli(["agents", "cancel", cancelledTask.id], temp.env, workspace);
    expect(JSON.parse(cancelled.stdout).status).toBe("cancelled");
    await expect(readFile(path.join(workspace, "stop-cli.json"), "utf8")).resolves.toContain(
      "agent_task_cancelled"
    );
  }, 15_000);
});
