import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { existsSync, rmSync } from "node:fs";

import { installSkillFromGitHub } from "../src/skills/install.js";
import { readSkillManifest } from "../src/skills/manifest.js";
import { materializeSkillFiles } from "../src/skills/materialize.js";

/**
 * Mock for the real hugohe3/ppt-master shape: 12140 files, NO author
 * manifest.yaml, and 11841 templates that are SVG *text* (so the binary/size
 * heuristics can't catch them). This is the case that proves `--defer`: without
 * it the SVGs land in core and install correctly refuses; with it the installer
 * declares templates/references as on-demand and core drops to ~156.
 *
 * Mirrors the live run verified against GitHub (core 156 / deferred 11984),
 * but offline so it can live in the suite.
 */

const TEMPLATE_COUNT = 11841;
const SCRIPT_COUNT = 144;
const WORKFLOW_COUNT = 11;
const CHART_COUNT = 20;

let skillsRoot: string | undefined;

afterEach(() => {
  if (skillsRoot) {
    rmSync(skillsRoot, { recursive: true, force: true });
    skillsRoot = undefined;
  }
});

const blobShaContent = (sha: string): string => Buffer.from(`mock:${sha}`).toString("base64");

function makeMockTree() {
  return [
    { path: "skills/ppt-master/SKILL.md", type: "blob", sha: "sha-skill", size: 50738 },
    { path: "skills/ppt-master/requirements.txt", type: "blob", sha: "sha-req", size: 123 },
    { path: "skills/ppt-master/.env.example", type: "blob", sha: "sha-env", size: 80 },
    ...Array.from({ length: SCRIPT_COUNT }, (_, i) => ({
      path: `skills/ppt-master/scripts/script${i}.py`,
      type: "blob",
      sha: `sha-script-${i}`,
      size: 500
    })),
    ...Array.from({ length: WORKFLOW_COUNT }, (_, i) => ({
      path: `skills/ppt-master/workflows/wf${i}.md`,
      type: "blob",
      sha: `sha-wf-${i}`,
      size: 300
    })),
    // SVG templates: text, not binary — heuristics can't defer these. A small
    // subset lives under templates/charts/ so a materialize glob can target
    // just those without writing all ~11.8k files (per-file fsync is slow).
    ...Array.from({ length: TEMPLATE_COUNT - CHART_COUNT }, (_, i) => ({
      path: `skills/ppt-master/templates/t${i}.svg`,
      type: "blob",
      sha: `sha-tpl-${i}`,
      size: 8000
    })),
    ...Array.from({ length: CHART_COUNT }, (_, i) => ({
      path: `skills/ppt-master/templates/charts/c${i}.svg`,
      type: "blob",
      sha: `sha-chart-${i}`,
      size: 8000
    })),
    {
      path: "skills/ppt-master/references/img1.png",
      type: "blob",
      sha: "sha-png1",
      size: 1_800_000
    },
    {
      path: "skills/ppt-master/references/img2.png",
      type: "blob",
      sha: "sha-png2",
      size: 1_600_000
    }
  ];
}

function makeMockFetchJson(tree: ReturnType<typeof makeMockTree>) {
  return async (url: string): Promise<unknown> => {
    if (url.includes("/git/trees/")) {
      return { tree, truncated: false };
    }
    if (url.includes("/git/blobs/")) {
      const sha = url.split("/git/blobs/")[1]!;
      return { content: blobShaContent(sha), encoding: "base64" };
    }
    if (/\/repos\/hugohe3\/ppt-master$/.test(url)) {
      return { default_branch: "main" };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

describe("ppt-master mock install and materialize", () => {
  it("defers templates/references via --defer, then materializes on demand", async () => {
    skillsRoot = path.join(process.cwd(), "tmp-test-ppt-master");
    const tree = makeMockTree();
    const fetchJson = makeMockFetchJson(tree);

    const result = await installSkillFromGitHub({
      source: "hugohe3/ppt-master",
      skillsRoot,
      deferGlobs: ["templates/**", "references/**"],
      deps: { fetchJson }
    });

    // Core = everything except the templates/references the installer deferred.
    const expectedCore = 2 + 1 + SCRIPT_COUNT + WORKFLOW_COUNT; // SKILL.md+req+env + scripts + workflows
    const expectedDeferred = TEMPLATE_COUNT + 2;
    expect(result.name).toBe("ppt-master");
    expect(result.coreFiles).toBe(expectedCore);
    expect(result.deferredFiles).toBe(expectedDeferred);
    expect(result.usedDeferGlobs).toBe(true);
    expect(result.usedAuthorManifest).toBe(false);

    const skillDir = path.join(skillsRoot, "ppt-master");
    const manifest = readSkillManifest(skillDir);
    expect(manifest).toBeDefined();
    expect(manifest!.source).toMatchObject({
      owner: "hugohe3",
      repo: "ppt-master",
      resolvedRef: "main"
    });
    expect(manifest!.core.length).toBe(expectedCore);
    expect(manifest!.deferred.length).toBe(expectedDeferred);

    // Core on disk, deferred absent.
    expect(existsSync(path.join(skillDir, "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(skillDir, "scripts/script0.py"))).toBe(true);
    expect(existsSync(path.join(skillDir, "templates/t0.svg"))).toBe(false);
    expect(existsSync(path.join(skillDir, "references/img1.png"))).toBe(false);

    // Materialize only the charts subset: `*` stays within a segment, so this
    // matches templates/charts/cN.svg but not the flat templates/tN.svg.
    const first = await materializeSkillFiles({
      skillDir,
      pattern: "templates/charts/*.svg",
      deps: { fetchJson }
    });
    expect(first.materialized.length).toBe(CHART_COUNT);
    expect(first.skipped.length).toBe(0);
    expect(existsSync(path.join(skillDir, "templates/charts/c0.svg"))).toBe(true);
    expect(existsSync(path.join(skillDir, "templates/t0.svg"))).toBe(false);

    // Re-running skips already-present files.
    const second = await materializeSkillFiles({
      skillDir,
      pattern: "templates/charts/*.svg",
      deps: { fetchJson }
    });
    expect(second.materialized.length).toBe(0);
    expect(second.skipped.length).toBe(CHART_COUNT);
  });

  it("refuses without --defer: SVG text templates fall into core and exceed the limit", async () => {
    skillsRoot = path.join(process.cwd(), "tmp-test-ppt-master-refuse");
    const tree = makeMockTree();
    const fetchJson = makeMockFetchJson(tree);

    await expect(
      installSkillFromGitHub({
        source: "hugohe3/ppt-master",
        skillsRoot,
        deps: { fetchJson }
      })
    ).rejects.toThrow(/exceeding the limit/);
  });
});
