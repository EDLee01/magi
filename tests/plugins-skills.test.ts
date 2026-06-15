import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { getMagiPaths } from "../src/paths.js";
import { listLocalPlugins, validatePluginManifest } from "../src/plugins/manifest.js";
import { discoverLocalMarketplaceSources, loadMarketplace } from "../src/plugins/marketplace.js";
import { findSkill, listSkills } from "../src/skills/loader.js";
import { executeSkillTool, parseSkillToolInput } from "../src/tools/skill-tool.js";
import { makeTempRoot, TempRoot } from "./helpers.js";

let temp: TempRoot | undefined;

afterEach(() => {
  temp?.cleanup();
  temp = undefined;
});

describe("plugins, marketplace, and skills", () => {
  it("validates clean-room plugin manifests and rejects unsafe entries", () => {
    expect(
      validatePluginManifest({
        schemaVersion: "0.1",
        name: "demo.plugin",
        version: "0.1.0",
        entry: "index.js",
        permissions: ["files.read"]
      })
    ).toMatchObject({ name: "demo.plugin", permissions: ["files.read"] });

    expect(() =>
      validatePluginManifest({
        schemaVersion: "0.1",
        name: "Bad Plugin",
        version: "0.1.0",
        permissions: []
      })
    ).toThrow(/lowercase plugin id/);

    expect(() =>
      validatePluginManifest({
        schemaVersion: "0.1",
        name: "demo.plugin",
        version: "0.1.0",
        entry: "../outside.js",
        permissions: []
      })
    ).toThrow(/relative in-plugin path/);
  });

  it("lists local plugins and custom local marketplaces", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const pluginRoot = path.join(paths.pluginsRoot, "demo.plugin");
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(
      path.join(pluginRoot, "plugin.json"),
      JSON.stringify({
        schemaVersion: "0.1",
        name: "demo.plugin",
        version: "0.1.0",
        permissions: ["files.read"]
      }),
      "utf8"
    );

    const marketplaceRoot = path.join(paths.pluginsRoot, "marketplaces", "local-demo");
    mkdirSync(marketplaceRoot, { recursive: true });
    writeFileSync(
      path.join(marketplaceRoot, "marketplace.json"),
      JSON.stringify({
        plugins: [{ name: "demo.plugin", version: "0.1.0", source: pluginRoot }]
      }),
      "utf8"
    );

    expect(listLocalPlugins(paths)).toHaveLength(1);
    const marketplaces = discoverLocalMarketplaceSources(paths).map(loadMarketplace);
    expect(marketplaces[0].entries[0]).toMatchObject({ name: "demo.plugin", source: pluginRoot });

    const plugins = await runCli(["plugins"], temp.env, process.cwd());
    expect(plugins.stdout).toContain("demo.plugin");
    const market = await runCli(["marketplace"], temp.env, process.cwd());
    expect(market.stdout).toContain("local-demo");
  });

  it("loads skills progressively from isolated skill roots", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const skillRoot = path.join(paths.skillsRoot, "review-helper");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      path.join(skillRoot, "SKILL.md"),
      "# Review Helper\n\nUse this for code review.\n",
      "utf8"
    );

    expect(listSkills(paths)).toMatchObject([{ name: "review-helper", body: undefined }]);
    expect(findSkill(paths, "review-helper")?.body).toContain("Use this for code review.");

    const list = await runCli(["skills", "list"], temp.env, process.cwd());
    expect(list.stdout).toContain("review-helper");
    const show = await runCli(["skills", "show", "review-helper"], temp.env, process.cwd());
    expect(show.stdout).toContain("Review Helper");
    const traversal = await runCli(["skills", "show", "../review-helper"], temp.env, process.cwd());
    expect(traversal.exitCode).toBe(2);
    expect(traversal.stderr).toContain("Skill not found");
  });

  it("invokes a skill with an imperative directive and the full body", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const skillRoot = path.join(paths.skillsRoot, "long-skill");
    mkdirSync(skillRoot, { recursive: true });
    // Body well over the old 900-char recall cap, with a marker near the end so
    // we can prove the full procedure (not a truncated prefix) reaches the model.
    const body = `# Long Skill\n\n${"step line filler. ".repeat(120)}\nFINAL_STEP_MARKER: produce the verdict.\n`;
    expect(body.length).toBeGreaterThan(900);
    writeFileSync(path.join(skillRoot, "SKILL.md"), body, "utf8");

    const output = executeSkillTool({
      request: parseSkillToolInput({ skill: "long-skill" }),
      skillsRoot: paths.skillsRoot
    });

    // Imperative framing so the model executes the skill rather than treating
    // it as passive context (the old behavior the user reported as "weak").
    expect(output).toContain('You are now running the "long-skill" skill');
    expect(output).toContain("Follow the procedure below step by step");
    // Full body, including the tail that the old 900-char cap would have cut.
    expect(output).toContain("FINAL_STEP_MARKER");
  });
});
