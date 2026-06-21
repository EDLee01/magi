import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { runCli } from "../src/cli.js";
import { ensureMagiHome, getMagiPaths } from "../src/paths.js";
import { makeTempRoot, TempRoot } from "./helpers.js";

let temp: TempRoot | undefined;

afterEach(() => {
  temp?.cleanup();
  temp = undefined;
});

describe("configuration", () => {
  it("generates ~/.magi-next/config.yaml equivalent when missing", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    expect(existsSync(paths.configFile)).toBe(false);
    const result = await runCli(["config"], temp.env, process.cwd());
    expect(result.exitCode).toBe(0);
    expect(existsSync(paths.configFile)).toBe(true);
  });

  it("returns a clear error for invalid config", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(paths.configFile, "providers: []\n", "utf8");

    const result = await runCli(["config"], temp.env, process.cwd());

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Invalid Magi config");
    expect(result.stderr).toContain("providers must be a mapping");
  });

  it("uses MAGI_CONFIG_DIR to switch test isolation directories", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    expect(paths.root).toBe(temp.path);
    expect(paths.configFile).toBe(path.join(temp.path, "config.yaml"));
  });

  it("validates provider and model alias schema", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      [
        "version: 0.1",
        "providers:",
        "  main:",
        "    type: openai",
        "    apiKeyEnv: MAGI_OPENAI_API_KEY",
        "    defaultModel: gpt-test",
        "models:",
        "  aliases:",
        "    fast: main:gpt-test-mini",
        ""
      ].join("\n"),
      "utf8"
    );

    const config = loadConfig(paths, temp.env);
    expect(config.providers.main.type).toBe("openai");
    expect(config.models.aliases.fast).toBe("main:gpt-test-mini");
    expect(config.models.fallbacks).toEqual({});
  });

  it("accepts provider apiKeyEnv outside the MAGI_* prefix", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      "providers:\n  bad:\n    type: openai\n    apiKeyEnv: CLAUDE_API_KEY\n",
      "utf8"
    );

    expect(() => loadConfig(paths, temp!.env)).not.toThrow();
  });

  it("validates fallback schema", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      [
        "providers:",
        "  main:",
        "    type: openai",
        "models:",
        "  aliases:",
        "    main: main:gpt-test",
        "  fallbacks:",
        "    main:",
        "      - main:gpt-test-backup",
        ""
      ].join("\n"),
      "utf8"
    );

    const config = loadConfig(paths, temp.env);
    expect(config.models.fallbacks.main).toEqual(["main:gpt-test-backup"]);
  });

  it("validates messages-compatible format schema", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      [
        "providers:",
        "  anthropic:",
        "    type: messages-compatible",
        "    format: anthropic-messages",
        "    apiKeyEnv: MAGI_ANTHROPIC_AUTH_TOKEN",
        "    baseUrl: https://example.invalid",
        "    defaultModel: claude-test",
        ""
      ].join("\n"),
      "utf8"
    );

    const config = loadConfig(paths, temp.env);
    expect(config.providers.anthropic.format).toBe("anthropic-messages");
  });

  it("validates WebSearch provider config and MAGI_* env boundaries", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      [
        "webSearch:",
        "  endpoint: https://search.example.invalid/query",
        "  apiKeyEnv: MAGI_WEBSEARCH_TOKEN",
        "  apiKeyHeader: x-api-key",
        "  locale: zh-Hans",
        "  market: CN",
        "  mainlandBoost: false",
        "  queryParam: query",
        "  resultsPath: data.items",
        "  titlePath: headline",
        "  urlPath: link",
        "  snippetPath: summary",
        "  maxResults: 7",
        ""
      ].join("\n"),
      "utf8"
    );

    const config = loadConfig(paths, temp.env);
    expect(config.webSearch).toEqual({
      provider: "http-json",
      endpoint: "https://search.example.invalid/query",
      apiKeyEnv: "MAGI_WEBSEARCH_TOKEN",
      apiKeyHeader: "x-api-key",
      locale: "zh-Hans",
      market: "CN",
      mainlandBoost: false,
      queryParam: "query",
      resultsPath: "data.items",
      titlePath: "headline",
      urlPath: "link",
      snippetPath: "summary",
      maxResults: 7
    });
  });

  it("accepts WebSearch apiKeyEnv outside the MAGI_* prefix", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      "webSearch:\n  endpoint: https://search.example.invalid/query\n  apiKeyEnv: CLAUDE_WEBSEARCH_TOKEN\n",
      "utf8"
    );

    expect(() => loadConfig(paths, temp!.env)).not.toThrow();
  });

  it("defaults WebSearch to mainland China locale and market", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(paths.configFile, "version: 0.1\n", "utf8");

    const config = loadConfig(paths, temp.env);
    expect(config.webSearch).toMatchObject({
      locale: "zh-CN",
      market: "CN",
      mainlandBoost: true
    });
  });

  it("validates memory retrieval and auto-write config", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      [
        "memory:",
        "  enabled: false",
        "  autoWrite: off",
        "  maxResults: 3",
        "  selectionModel: fast",
        "  writeDecisionModel: review",
        "  scopes:",
        "    - project",
        "    - session",
        ""
      ].join("\n"),
      "utf8"
    );

    const config = loadConfig(paths, temp.env);
    expect(config.memory).toEqual({
      enabled: false,
      autoWrite: "off",
      maxResults: 3,
      selectionModel: "fast",
      writeDecisionModel: "review",
      scopes: ["project", "session"],
      dream: { enabled: false, intervalMs: 24 * 60 * 60 * 1000 }
    });
  });

  it("rejects invalid memory auto-write and scope config", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(paths.configFile, "memory:\n  autoWrite: always\n", "utf8");
    expect(() => loadConfig(paths, temp!.env)).toThrow(/memory\.autoWrite must be off or explicit/);

    writeFileSync(paths.configFile, "memory:\n  scopes:\n    - legacy\n", "utf8");
    expect(() => loadConfig(paths, temp!.env)).toThrow(
      /memory\.scopes\.0 must be user, project, or session/
    );
  });

  it("validates hook schema", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      [
        "hooks:",
        "  - event: pre_tool_use",
        "    type: command",
        "    if: Bash(*)",
        "    command: printf ok",
        "    timeoutMs: 1000",
        ""
      ].join("\n"),
      "utf8"
    );

    const config = loadConfig(paths, temp.env);
    expect(config.hooks).toEqual([
      expect.objectContaining({
        event: "pre_tool_use",
        type: "command",
        command: "printf ok",
        timeoutMs: 1000
      })
    ]);
  });

  it("validates HTTP hook schema", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      [
        "hooks:",
        "  - event: notification",
        "    type: http",
        "    url: http://127.0.0.1:8765/hook",
        "    headers:",
        "      authorization: Bearer $MAGI_HOOK_TOKEN",
        "    allowedEnvVars:",
        "      - EXTRA_HOOK_TOKEN",
        ""
      ].join("\n"),
      "utf8"
    );

    const config = loadConfig(paths, temp.env);
    expect(config.hooks[0]).toMatchObject({
      event: "notification",
      type: "http",
      url: "http://127.0.0.1:8765/hook",
      headers: { authorization: "Bearer $MAGI_HOOK_TOKEN" },
      allowedEnvVars: ["EXTRA_HOOK_TOKEN"]
    });
  });

  it("rejects HTTP hooks without a URL", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(paths.configFile, "hooks:\n  - event: notification\n    type: http\n", "utf8");

    expect(() => loadConfig(paths, temp!.env)).toThrow(/hooks\.0\.url is required/);
  });

  it("validates prompt hook schema with explicit model", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      [
        "hooks:",
        "  - event: session_end",
        "    type: prompt",
        "    prompt: summarize $ARGUMENTS",
        "    model: provider:haiku",
        ""
      ].join("\n"),
      "utf8"
    );

    const config = loadConfig(paths, temp.env);
    expect(config.hooks[0]).toMatchObject({
      event: "session_end",
      type: "prompt",
      prompt: "summarize $ARGUMENTS",
      model: "provider:haiku"
    });
  });

  it("rejects prompt hooks without explicit model", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      "hooks:\n  - event: session_end\n    type: prompt\n    prompt: summarize\n",
      "utf8"
    );

    expect(() => loadConfig(paths, temp!.env)).toThrow(/hooks\.0\.model is required/);
  });

  it("validates context compaction schema", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      [
        "context:",
        "  recentMessages: 8",
        "  autoCompactTokenThreshold: 1000",
        "  compactionModel: summary:haiku",
        ""
      ].join("\n"),
      "utf8"
    );

    const config = loadConfig(paths, temp.env);
    expect(config.context).toEqual({
      recentMessages: 8,
      autoCompactTokenThreshold: 1000,
      autoCompactMessageThreshold: 80,
      compactionModel: "summary:haiku"
    });
  });

  it("defaults context settings without selecting a compaction model", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(paths.configFile, "version: 0.1\n", "utf8");

    const config = loadConfig(paths, temp.env);
    expect(config.context).toEqual({
      recentMessages: 6,
      autoCompactTokenThreshold: 150_000,
      autoCompactMessageThreshold: 80,
      compactionModel: undefined
    });
  });

  it("accepts lifecycle and notification hook events", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      [
        "hooks:",
        "  - event: session_start",
        "    type: command",
        "    command: printf start",
        "  - event: session_end",
        "    type: command",
        "    command: printf end",
        "  - event: pre_compact",
        "    type: command",
        "    command: printf pre",
        "  - event: post_compact",
        "    type: command",
        "    command: printf post",
        "  - event: notification",
        "    type: command",
        "    command: printf note",
        "  - event: stop",
        "    type: command",
        "    command: printf stop",
        ""
      ].join("\n"),
      "utf8"
    );

    const config = loadConfig(paths, temp.env);
    expect(config.hooks.map((hook) => hook.event)).toEqual([
      "session_start",
      "session_end",
      "pre_compact",
      "post_compact",
      "notification",
      "stop"
    ]);
  });

  it("rejects invalid provider type", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(paths.configFile, "providers:\n  bad:\n    type: web-login\n", "utf8");

    expect(() => loadConfig(paths, temp!.env)).toThrow(
      /providers\.bad\.type must be openai or messages-compatible/
    );
  });

  it("rejects invalid model alias targets", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(paths.configFile, "models:\n  aliases:\n    fast: ''\n", "utf8");

    expect(() => loadConfig(paths, temp!.env)).toThrow(
      /models\.aliases\.fast must be a non-empty string/
    );
  });

  it("accepts router specialty and priority metadata", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      [
        "models:",
        "  router:",
        "    codex:",
        "      family: gpt",
        "      role: main",
        "      contextWindow: 400000",
        "      supportsVision: true",
        "      specialty: coding",
        "      priority: 3",
        ""
      ].join("\n"),
      "utf8"
    );

    const config = loadConfig(paths, temp.env);
    expect(config.models.router?.codex).toMatchObject({ specialty: "coding", priority: 3 });
  });
});
