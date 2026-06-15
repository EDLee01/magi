#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const currentVersion = JSON.parse(
  readFileSync(path.join(repoRoot, "package.json"), "utf8")
).version;
const baselineRef = process.env.MAGI_BASELINE_REF ?? "v0.1.8-baseline-20260609";
const root = mkdtempSync(path.join(os.tmpdir(), "magi-upgrade-rollback-"));
const baselineRoot = path.join(root, "baseline");
const artifactsRoot = path.join(root, "artifacts");
const installRoot = path.join(root, "install");
const configRoot = path.join(root, "config");
const reportPath =
  process.env.MAGI_UPGRADE_ROLLBACK_REPORT ??
  path.join(repoRoot, ".magi-reports", "upgrade-rollback-smoke.json");
let baselineWorktreeCreated = false;

try {
  mkdirSync(artifactsRoot, { recursive: true });
  run("git", ["worktree", "add", "--detach", baselineRoot, baselineRef], { cwd: repoRoot });
  baselineWorktreeCreated = true;
  symlinkSync(path.join(repoRoot, "node_modules"), path.join(baselineRoot, "node_modules"), "dir");

  run("npm", ["run", "build"], { cwd: baselineRoot });
  run("npm", ["run", "build"], { cwd: repoRoot });
  const baselinePackage = pack(baselineRoot, artifactsRoot);
  const currentPackage = pack(repoRoot, artifactsRoot);

  install(baselinePackage);
  const baselineVersion = cli(["--version"]);
  assert(baselineVersion.includes("0.1.8"), `expected baseline 0.1.8, got ${baselineVersion}`);
  cli(["goal", "upgrade rollback smoke marker"]);
  assert(cli(["goal"]).includes("upgrade rollback smoke marker"), "baseline goal was not persisted");

  install(currentPackage);
  const upgradedVersion = cli(["--version"]);
  assert(
    upgradedVersion.includes(currentVersion),
    `expected upgraded ${currentVersion}, got ${upgradedVersion}`
  );
  assert(cli(["goal"]).includes("upgrade rollback smoke marker"), "upgrade lost persisted goal state");

  install(baselinePackage);
  const rolledBackVersion = cli(["--version"]);
  assert(rolledBackVersion.includes("0.1.8"), `expected rollback 0.1.8, got ${rolledBackVersion}`);
  assert(cli(["goal"]).includes("upgrade rollback smoke marker"), "rollback lost persisted goal state");

  const report = {
    version: 1,
    name: "upgrade-rollback-smoke",
    generatedAt: new Date().toISOString(),
    status: "passed",
    baselineRef,
    baselineVersion: cleanVersion(baselineVersion),
    upgradedVersion: cleanVersion(upgradedVersion),
    rolledBackVersion: cleanVersion(rolledBackVersion),
    stateContract: "active goal persisted across install, upgrade, and rollback",
    configRootIsolated: configRoot.startsWith(root)
  };
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report));
  console.log(`Upgrade/rollback report: ${reportPath}`);
} finally {
  if (baselineWorktreeCreated) {
    run("git", ["worktree", "remove", "--force", baselineRoot], {
      cwd: repoRoot,
      allowFailure: true
    });
  }
  rmSync(root, { recursive: true, force: true });
}

function pack(cwd, destination) {
  const result = run("npm", ["pack", "--json", "--pack-destination", destination], { cwd });
  const parsed = JSON.parse(result.stdout);
  const filename = parsed[0]?.filename;
  if (typeof filename !== "string") {
    throw new Error(`npm pack did not return a filename for ${cwd}`);
  }
  return path.join(destination, filename);
}

function install(packageFile) {
  run(
    "npm",
    ["install", "--prefix", installRoot, "--no-audit", "--no-fund", "--save=false", packageFile],
    { cwd: root }
  );
}

function cli(args) {
  const bin = path.join(installRoot, "node_modules", ".bin", "magi");
  assert(existsSync(bin), `installed magi binary is missing: ${bin}`);
  return run(bin, ["--no-color", ...args], {
    cwd: root,
    env: {
      ...process.env,
      MAGI_CONFIG_DIR: configRoot,
      MAGI_DISABLE_MDNS: "1",
      NO_COLOR: "1"
    }
  }).stdout.trim();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.error && !options.allowFailure) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout}\n${result.stderr}`
    );
  }
  return result;
}

function cleanVersion(output) {
  return output.split(/\s+/).find((part) => /^\d+\.\d+\.\d+$/.test(part)) ?? output;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
