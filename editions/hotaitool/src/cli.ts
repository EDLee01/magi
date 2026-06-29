#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

import { getHotaitoolPaths } from "./config.js";
import { loadProviderEnvFile } from "./env-file.js";
import { formatSetupReport, runSetup } from "./setup.js";

const require = createRequire(import.meta.url);

function resolveMagiCli(): string {
  try {
    const pkgJson = require.resolve("@edwardlee5423/magi/package.json");
    return path.join(path.dirname(pkgJson), "dist/cli.js");
  } catch {
    return "magi";
  }
}

function buildRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const paths = getHotaitoolPaths(env);
  const merged = loadProviderEnvFile(paths.providerEnvFile, { ...env });
  return {
    ...merged,
    MAGI_CONFIG_DIR: paths.root
  };
}

function delegateToMagi(args: string[], env: NodeJS.ProcessEnv): number {
  const magiCli = resolveMagiCli();
  const result = spawnSync(process.execPath, [magiCli, ...args], {
    env: buildRuntimeEnv(env),
    stdio: "inherit"
  });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

function printHelp(): void {
  process.stdout.write(`Magi HotAITool edition

Usage:
  magi-hotaitool setup                 Initialize ~/.magi-hotaitool config
  magi-hotaitool doctor                Show edition paths, then run magi doctor
  magi-hotaitool <magi args...>        Run magi with the HotAITool config root

This package is separate from the main @edwardlee5423/magi distribution.
Config root defaults to ~/.magi-hotaitool (override with MAGI_HOTAITOOL_CONFIG_DIR).

`);
}

async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return 0;
  }

  if (command === "setup") {
    const runtimeEnv = buildRuntimeEnv(env);
    const result = runSetup(runtimeEnv);
    process.stdout.write(formatSetupReport(result, runtimeEnv));
    return result.reason && !result.wroteConfig ? 1 : 0;
  }

  if (command === "doctor") {
    const runtimeEnv = buildRuntimeEnv(env);
    process.stdout.write(formatSetupReport(runSetup(runtimeEnv), runtimeEnv));
    return delegateToMagi(["doctor"], env);
  }

  return delegateToMagi([command, ...rest], env);
}

main(process.argv.slice(2), process.env).then((code) => {
  process.exitCode = code;
});
