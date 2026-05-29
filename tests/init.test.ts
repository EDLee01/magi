import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { runInit } from "../src/commands/init.js";
import { getMagiPaths, ensureMagiHome } from "../src/paths.js";

describe("magi init", () => {
  let tmpRoot: string | undefined;
  afterEach(() => {
    if (tmpRoot) {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
      tmpRoot = undefined;
    }
  });

  function makePaths(env: NodeJS.ProcessEnv = {}) {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "magi-init-"));
    const fullEnv = { ...env, MAGI_CONFIG_DIR: tmpRoot };
    const paths = getMagiPaths(fullEnv);
    ensureMagiHome(paths);
    return { paths, env: fullEnv };
  }

  it("writes a config when ANTHROPIC_AUTH_TOKEN is detected (non-interactive)", async () => {
    const { paths, env } = makePaths({ ANTHROPIC_AUTH_TOKEN: "fake-key" });
    const result = await runInit({ paths, env, nonInteractive: true });
    expect(result.wrote).toBe(true);
    expect(result.providerName).toBe("anthropic");
    const content = readFileSync(paths.configFile, "utf8");
    expect(content).toContain("apiKeyEnv: ANTHROPIC_AUTH_TOKEN");
    expect(content).toContain("type: messages-compatible");
    expect(content).toContain("format: anthropic-messages");
    expect(content).toContain("fast: anthropic:claude-haiku-4-5");
    expect(content).toContain("main: anthropic:claude-sonnet-4-6");
    expect(content).toContain("deep: anthropic:claude-opus-4-7");
    expect(content).toContain("router:");
  });

  it("writes a config when OPENAI_API_KEY is detected", async () => {
    const { paths, env } = makePaths({ OPENAI_API_KEY: "sk-test" });
    const result = await runInit({ paths, env, nonInteractive: true });
    expect(result.wrote).toBe(true);
    expect(result.providerName).toBe("openai");
    const content = readFileSync(paths.configFile, "utf8");
    expect(content).toContain("apiKeyEnv: OPENAI_API_KEY");
    expect(content).toContain("type: openai");
    expect(content).toContain("baseUrl: https://api.openai.com/v1");
    expect(content).toContain("fast: openai:gpt-5.5");
    expect(content).toContain("main: openai:gpt-5.5");
    expect(content).toContain("deep: openai:gpt-5.5");
  });

  it("respects an explicit preset over auto-detection", async () => {
    const { paths, env } = makePaths({ ANTHROPIC_AUTH_TOKEN: "fake", OPENAI_API_KEY: "sk-test" });
    const result = await runInit({ paths, env, nonInteractive: true, preset: "deepseek" });
    expect(result.wrote).toBe(true);
    expect(result.providerName).toBe("deepseek");
    const content = readFileSync(paths.configFile, "utf8");
    expect(content).toContain("type: openai");
    expect(content).toContain("deepseek-chat");
  });

  it("refuses to overwrite an existing real config in non-interactive mode", async () => {
    const { paths, env } = makePaths({ ANTHROPIC_AUTH_TOKEN: "fake-key" });
    // Write a non-stub config
    writeFileSync(
      paths.configFile,
      [
        "version: 0.1",
        "providers:",
        "  custom:",
        "    type: openai",
        "models:",
        "  aliases:",
        "    main: custom:gpt-x"
      ].join("\n"),
      "utf8"
    );
    const result = await runInit({ paths, env, nonInteractive: true });
    expect(result.wrote).toBe(false);
    expect(result.reason).toContain("config already exists");
    // Original config should be intact
    const content = readFileSync(paths.configFile, "utf8");
    expect(content).toContain("custom:gpt-x");
  });

  it("overwrites the stub config that ensureMagiHome wrote", async () => {
    const { paths, env } = makePaths({ ANTHROPIC_AUTH_TOKEN: "fake" });
    // ensureMagiHome already wrote the stub. Verify it's a stub
    expect(existsSync(paths.configFile)).toBe(true);
    expect(readFileSync(paths.configFile, "utf8")).toContain("providers: {}");
    // init should overwrite it without prompting
    const result = await runInit({ paths, env, nonInteractive: true });
    expect(result.wrote).toBe(true);
    expect(readFileSync(paths.configFile, "utf8")).toContain("anthropic:");
  });

  it("returns a credentials-missing message when no env vars are set", async () => {
    const { paths, env } = makePaths({});
    const result = await runInit({ paths, env, nonInteractive: true });
    expect(result.wrote).toBe(false);
    expect(result.reason).toMatch(/credentials/i);
  });
});
