import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { getMagiPaths } from "../src/paths.js";
import { listLocalPlugins, validatePluginManifest } from "../src/plugins/manifest.js";
import { discoverLocalMarketplaceSources, loadMarketplace } from "../src/plugins/marketplace.js";
import { findSkill, listSkills } from "../src/skills/loader.js";
import {
  installSkillFromGitHub,
  parseSkillSource,
  SkillInstallError
} from "../src/skills/install.js";
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

  it("uses frontmatter description as the skill summary", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const skillRoot = path.join(paths.skillsRoot, "earth-helper");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      path.join(skillRoot, "SKILL.md"),
      [
        "---",
        "name: earth-helper",
        "description: Analyze earth science data with care.",
        "tags: [earth, data]",
        "---",
        "",
        "# Earth Helper",
        "",
        "Body content here.",
        ""
      ].join("\n"),
      "utf8"
    );

    expect(listSkills(paths)).toMatchObject([
      { name: "earth-helper", summary: "Analyze earth science data with care." }
    ]);

    const list = await runCli(["skills", "list"], temp.env, process.cwd());
    expect(list.stdout).toContain("Analyze earth science data with care.");
    expect(list.stdout).not.toContain("earth-helper\t---");
  });

  it("reads a YAML block scalar description (folded style)", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const skillRoot = path.join(paths.skillsRoot, "ppt-helper");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      path.join(skillRoot, "SKILL.md"),
      [
        "---",
        "name: ppt-helper",
        "description: >",
        "  AI-driven SVG content system. Converts source documents",
        "  into PPTX through multi-role collaboration.",
        "---",
        "",
        "# PPT Helper",
        ""
      ].join("\n"),
      "utf8"
    );

    expect(listSkills(paths)).toMatchObject([
      {
        name: "ppt-helper",
        summary:
          "AI-driven SVG content system. Converts source documents into PPTX through multi-role collaboration."
      }
    ]);
  });

  it("uses the YAML frontmatter description as the skill summary", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const skillRoot = path.join(paths.skillsRoot, "fm-skill");
    mkdirSync(skillRoot, { recursive: true });
    // Folded (`>`) multi-line description, like real marketplace/Claude Code skills.
    writeFileSync(
      path.join(skillRoot, "SKILL.md"),
      [
        "---",
        "name: fm-skill",
        "description: >",
        "  Make a slide deck from a document. Use when the user says",
        '  "做PPT" or "create presentation".',
        "---",
        "",
        "# FM Skill",
        "",
        "Body goes here.",
        ""
      ].join("\n"),
      "utf8"
    );

    const [skill] = listSkills(paths);
    // Old behavior put "---" here, which made the skill invisible to keyword recall.
    expect(skill.summary).not.toBe("---");
    expect(skill.summary).toContain("Make a slide deck");
    expect(skill.summary).toContain("做PPT");
    // Folded block is collapsed to a single line.
    expect(skill.summary).not.toContain("\n");
  });

  it("falls back to the first body line when frontmatter lacks a description", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const skillRoot = path.join(paths.skillsRoot, "bare-helper");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      path.join(skillRoot, "SKILL.md"),
      ["---", "name: bare-helper", "---", "", "# Bare Helper", "", "Body."].join("\n"),
      "utf8"
    );

    expect(listSkills(paths)).toMatchObject([{ name: "bare-helper", summary: "Bare Helper" }]);
  });

  it("falls back to the first heading when a skill has no frontmatter", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const skillRoot = path.join(paths.skillsRoot, "plain-skill");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      path.join(skillRoot, "SKILL.md"),
      "# Plain Skill\n\nDoes a plain thing.\n",
      "utf8"
    );
    const [skill] = listSkills(paths);
    expect(skill.summary).toBe("Plain Skill");
  });

  it("parses skill sources in shorthand, URL, and subdir forms", () => {
    expect(parseSkillSource("owner/repo")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseSkillSource("owner/repo/skills/ppt")).toEqual({
      owner: "owner",
      repo: "repo",
      subdir: "skills/ppt"
    });
    expect(parseSkillSource("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo"
    });
    expect(parseSkillSource("https://github.com/owner/repo/tree/main/skills/ppt")).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "main",
      subdir: "skills/ppt"
    });
    expect(parseSkillSource("git@github.com:owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo"
    });
    expect(() => parseSkillSource("not-a-repo")).toThrow(SkillInstallError);
    expect(() => parseSkillSource("owner/../escape")).toThrow(SkillInstallError);
    expect(() => parseSkillSource("https://gitlab.com/owner/repo")).toThrow(/github\.com/);
  });

  it("installs a skill from a stubbed GitHub repo without cloning", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);

    const skillMd = [
      "---",
      "name: stub-skill",
      "description: A stubbed skill.",
      "---",
      "",
      "# Stub"
    ].join("\n");
    const blobs: Record<string, string> = {
      "sha-skill": Buffer.from(skillMd, "utf8").toString("base64"),
      "sha-ref": Buffer.from("reference body", "utf8").toString("base64")
    };
    const fetchJson = async (url: string): Promise<unknown> => {
      if (url === "https://api.github.com/repos/acme/pack") {
        return { default_branch: "main" };
      }
      if (url.startsWith("https://api.github.com/repos/acme/pack/git/trees/main")) {
        return {
          truncated: false,
          tree: [
            { path: "skills", type: "tree", sha: "sha-dir" },
            { path: "skills/stub-skill", type: "tree", sha: "sha-skilldir" },
            {
              path: "skills/stub-skill/SKILL.md",
              type: "blob",
              sha: "sha-skill",
              size: skillMd.length
            },
            {
              path: "skills/stub-skill/references/notes.md",
              type: "blob",
              sha: "sha-ref",
              size: 13
            },
            { path: "README.md", type: "blob", sha: "sha-readme", size: 4 }
          ]
        };
      }
      const blobMatch = /\/git\/blobs\/(.+)$/.exec(url);
      if (blobMatch && blobs[blobMatch[1]]) {
        return { encoding: "base64", content: blobs[blobMatch[1]] };
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const result = await installSkillFromGitHub({
      source: "acme/pack/skills/stub-skill",
      skillsRoot: paths.skillsRoot,
      deps: { fetchJson }
    });

    expect(result.name).toBe("stub-skill");
    expect(result.resolvedRef).toBe("main");
    expect(result.files).toEqual(["SKILL.md", "references/notes.md"]);

    const installed = findSkill(paths, "stub-skill");
    expect(installed?.summary).toBe("A stubbed skill.");
    expect(
      readFileSync(path.join(paths.skillsRoot, "stub-skill", "references", "notes.md"), "utf8")
    ).toBe("reference body");

    await expect(
      installSkillFromGitHub({
        source: "acme/pack/skills/stub-skill",
        skillsRoot: paths.skillsRoot,
        deps: { fetchJson }
      })
    ).rejects.toThrow(/already exists/);
  });

  it("auto-detects a single skill at the repo root", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);

    const skillMd = ["---", "name: root-skill", "description: Root level skill.", "---"].join("\n");
    const fetchJson = async (url: string): Promise<unknown> => {
      if (url === "https://api.github.com/repos/acme/single") {
        return { default_branch: "trunk" };
      }
      if (url.startsWith("https://api.github.com/repos/acme/single/git/trees/trunk")) {
        return {
          truncated: false,
          tree: [{ path: "SKILL.md", type: "blob", sha: "sha-root", size: skillMd.length }]
        };
      }
      if (url.endsWith("/git/blobs/sha-root")) {
        return { encoding: "base64", content: Buffer.from(skillMd, "utf8").toString("base64") };
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const result = await installSkillFromGitHub({
      source: "acme/single",
      skillsRoot: paths.skillsRoot,
      deps: { fetchJson }
    });

    expect(result.name).toBe("single");
    expect(result.skillDir).toBe("");
    expect(findSkill(paths, "single")?.summary).toBe("Root level skill.");
  });

  it("rejects ambiguous repos with multiple skills", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);

    const fetchJson = async (url: string): Promise<unknown> => {
      if (url === "https://api.github.com/repos/acme/many") {
        return { default_branch: "main" };
      }
      if (url.startsWith("https://api.github.com/repos/acme/many/git/trees/main")) {
        return {
          truncated: false,
          tree: [
            { path: "skills/a/SKILL.md", type: "blob", sha: "a" },
            { path: "skills/b/SKILL.md", type: "blob", sha: "b" }
          ]
        };
      }
      throw new Error(`unexpected url: ${url}`);
    };

    await expect(
      installSkillFromGitHub({
        source: "acme/many",
        skillsRoot: paths.skillsRoot,
        deps: { fetchJson }
      })
    ).rejects.toThrow(/Multiple skills/);
  });

  it("removes stale files when reinstalling with force", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);

    const skillMd = ["---", "name: drift", "description: Drift skill.", "---"].join("\n");
    let includeOld = true;
    const fetchJson = async (url: string): Promise<unknown> => {
      if (url === "https://api.github.com/repos/acme/drift") {
        return { default_branch: "main" };
      }
      if (url.startsWith("https://api.github.com/repos/acme/drift/git/trees/main")) {
        return {
          truncated: false,
          tree: [
            { path: "SKILL.md", type: "blob", sha: "sha-skill", size: skillMd.length },
            ...(includeOld ? [{ path: "old.md", type: "blob", sha: "sha-old", size: 3 }] : [])
          ]
        };
      }
      if (url.endsWith("/git/blobs/sha-skill")) {
        return { encoding: "base64", content: Buffer.from(skillMd, "utf8").toString("base64") };
      }
      if (url.endsWith("/git/blobs/sha-old")) {
        return { encoding: "base64", content: Buffer.from("old", "utf8").toString("base64") };
      }
      throw new Error(`unexpected url: ${url}`);
    };

    await installSkillFromGitHub({
      source: "acme/drift",
      skillsRoot: paths.skillsRoot,
      deps: { fetchJson }
    });
    expect(existsSync(path.join(paths.skillsRoot, "drift", "old.md"))).toBe(true);

    includeOld = false;
    await installSkillFromGitHub({
      source: "acme/drift",
      skillsRoot: paths.skillsRoot,
      force: true,
      deps: { fetchJson }
    });
    expect(existsSync(path.join(paths.skillsRoot, "drift", "old.md"))).toBe(false);
    expect(existsSync(path.join(paths.skillsRoot, "drift", "SKILL.md"))).toBe(true);
  });
});
