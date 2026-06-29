import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  DEFAULT_HOTAITOOL_CLAUDE_BASE_URL,
  DEFAULT_HOTAITOOL_OPENAI_BASE_URL,
  getHotaitoolPaths,
  renderHotaitoolConfig
} from "../src/config.js";
import { runSetup } from "../src/setup.js";

describe("magi-hotaitool edition", () => {
  let tmpRoot: string | undefined;

  afterEach(() => {
    if (tmpRoot) {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
      tmpRoot = undefined;
    }
  });

  function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "magi-hotaitool-"));
    return { ...extra, MAGI_HOTAITOOL_CONFIG_DIR: tmpRoot };
  }

  it("uses a separate config root from main magi", () => {
    const defaultPaths = getHotaitoolPaths({});
    expect(defaultPaths.root.endsWith(`${path.sep}.magi-hotaitool`)).toBe(true);
    const runtime = env();
    const customPaths = getHotaitoolPaths(runtime);
    expect(customPaths.root).toBe(runtime.MAGI_HOTAITOOL_CONFIG_DIR);
    expect(customPaths.root).not.toContain(".magi-next");
  });

  it("writes dual-provider config when credentials are present", () => {
    const result = runSetup(
      env({
        ANTHROPIC_AUTH_TOKEN: "fake-key"
      })
    );
    expect(result.wroteConfig).toBe(true);
    const content = readFileSync(result.configFile, "utf8");
    expect(content).toContain("hotaitool-claude:");
    expect(content).toContain("hotaitool-openai:");
    expect(content).toContain(`baseUrl: ${DEFAULT_HOTAITOOL_CLAUDE_BASE_URL}`);
    expect(content).toContain(`baseUrl: ${DEFAULT_HOTAITOOL_OPENAI_BASE_URL}`);
  });

  it("creates provider.env template when credentials are missing", () => {
    const runtime = env();
    const result = runSetup(runtime);
    expect(result.wroteProviderEnv).toBe(true);
    expect(existsSync(result.providerEnvFile)).toBe(true);
    expect(result.wroteConfig).toBe(false);
    expect(result.reason).toMatch(/credentials missing/i);
  });

  it("supports openai-only credentials", () => {
    const yaml = renderHotaitoolConfig({ OPENAI_API_KEY: "sk-test" });
    expect(yaml).toContain("hotaitool-openai:");
    expect(yaml).not.toContain("hotaitool-claude:");
    expect(yaml).toContain("main: hotaitool-openai:gpt-5.5");
  });
});
