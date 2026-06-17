import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { classifySkillFiles, parseAuthorDeclaration } from "../src/skills/classify.js";
import {
  buildSkillManifest,
  readSkillManifest,
  SKILL_MANIFEST_FILE,
  writeSkillManifest
} from "../src/skills/manifest.js";
import { installSkillFromGitHub } from "../src/skills/install.js";
import {
  materializeDeferredPath,
  materializeSkillFiles,
  SkillMaterializeError
} from "../src/skills/materialize.js";
import { getMagiPaths } from "../src/paths.js";
import { makeTempRoot, TempRoot } from "./helpers.js";

let temp: TempRoot | undefined;

afterEach(() => {
  temp?.cleanup();
  temp = undefined;
});

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

describe("skill core/deferred classification", () => {
  it("defers binaries and oversized files, keeps text/code as core", () => {
    const result = classifySkillFiles({
      blobs: [
        { path: "SKILL.md", sha: "a", size: 100 },
        { path: "scripts/run.py", sha: "b", size: 2000 },
        { path: "templates/logo.png", sha: "c", size: 50000 },
        { path: "data/big.txt", sha: "d", size: 300 * 1024 }
      ]
    });

    expect(result.core.map((e) => e.path).sort()).toEqual(["SKILL.md", "scripts/run.py"]);
    expect(result.deferred.map((e) => e.path).sort()).toEqual([
      "data/big.txt",
      "templates/logo.png"
    ]);
    expect(result.usedAuthorManifest).toBe(false);
  });

  it("keeps many small text files as core (no file-count threshold)", () => {
    const blobs = Array.from({ length: 200 }, (_, i) => ({
      path: `templates/t${i}.svg`,
      sha: `sha-${i}`,
      size: 1000
    }));
    blobs.push({ path: "SKILL.md", sha: "skill", size: 100 });

    const result = classifySkillFiles({ blobs });

    // SVG is text; with no author manifest and no threshold, all stay core.
    expect(result.deferred).toHaveLength(0);
    expect(result.core).toHaveLength(201);
  });

  it("--full forces everything into core", () => {
    const result = classifySkillFiles({
      blobs: [
        { path: "SKILL.md", sha: "a", size: 100 },
        { path: "templates/logo.png", sha: "c", size: 50000 }
      ],
      full: true
    });
    expect(result.deferred).toHaveLength(0);
    expect(result.core).toHaveLength(2);
  });

  it("honors an author manifest: always_load/axes are core, on_demand is deferred", () => {
    const manifestYaml = [
      "name: demo",
      "always_load:",
      "  - static/core/principles.md",
      "  - ../_shared/core/ledger.md",
      "axes:",
      "  source_format:",
      "    values:",
      "      pdf: static/fragments/pdf.md",
      "      html: static/fragments/html.md",
      "references:",
      "  on_demand:",
      "    - condition: cropping figures",
      "      path: references/figure-extraction.md"
    ].join("\n");

    const result = classifySkillFiles({
      blobs: [
        { path: "SKILL.md", sha: "s", size: 100 },
        { path: "manifest.yaml", sha: "m", size: 200 },
        { path: "static/core/principles.md", sha: "a", size: 300 },
        { path: "static/fragments/pdf.md", sha: "b", size: 300 },
        { path: "static/fragments/html.md", sha: "c", size: 300 },
        { path: "references/figure-extraction.md", sha: "d", size: 300 }
      ],
      authorManifestText: manifestYaml
    });

    expect(result.usedAuthorManifest).toBe(true);
    expect(result.deferred.map((e) => e.path)).toEqual(["references/figure-extraction.md"]);
    expect(result.core.map((e) => e.path).sort()).toEqual([
      "SKILL.md",
      "manifest.yaml",
      "static/core/principles.md",
      "static/fragments/html.md",
      "static/fragments/pdf.md"
    ]);
  });

  it("drops escaping paths from author declarations", () => {
    const decl = parseAuthorDeclaration(
      ["always_load:", "  - ../_shared/x.md", "  - static/ok.md"].join("\n")
    );
    expect(decl?.core.has("static/ok.md")).toBe(true);
    expect(decl?.core.has("../_shared/x.md")).toBe(false);
  });
});

describe("skill install manifest read/write", () => {
  it("round-trips a manifest with computed stats", () => {
    temp = makeTempRoot();
    const dir = path.join(temp.path, "skill");
    mkdirSync(dir, { recursive: true });

    const manifest = buildSkillManifest({
      source: { owner: "o", repo: "r", resolvedRef: "abc123", subdir: "skills/x" },
      core: [{ path: "SKILL.md", sha: "a", size: 100 }],
      deferred: [{ path: "templates/logo.png", sha: "b", size: 5000 }],
      installedAt: "2026-01-01T00:00:00.000Z"
    });
    expect(manifest.stats).toEqual({
      totalFiles: 2,
      coreFiles: 1,
      coreBytes: 100,
      deferredFiles: 1,
      deferredBytes: 5000
    });

    writeSkillManifest(dir, manifest);
    expect(existsSync(path.join(dir, SKILL_MANIFEST_FILE))).toBe(true);
    expect(readSkillManifest(dir)).toEqual(manifest);
  });

  it("returns undefined for a missing or malformed manifest", () => {
    temp = makeTempRoot();
    const dir = path.join(temp.path, "skill");
    mkdirSync(dir, { recursive: true });
    expect(readSkillManifest(dir)).toBeUndefined();

    writeFileSync(path.join(dir, SKILL_MANIFEST_FILE), "{ not valid json", "utf8");
    expect(readSkillManifest(dir)).toBeUndefined();

    writeFileSync(path.join(dir, SKILL_MANIFEST_FILE), JSON.stringify({ source: {} }), "utf8");
    expect(readSkillManifest(dir)).toBeUndefined();
  });
});

describe("install defers resources and records a manifest", () => {
  it("materializes core, leaves a binary deferred, writes .magi-skill.json", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);

    const skillMd = ["---", "name: deferred-demo", "description: Demo.", "---", "", "# Demo"].join(
      "\n"
    );
    const blobs: Record<string, string> = {
      "sha-skill": b64(skillMd),
      "sha-script": b64("print('hi')")
    };
    const fetchJson = async (url: string): Promise<unknown> => {
      if (url === "https://api.github.com/repos/acme/deferred") {
        return { default_branch: "main" };
      }
      if (url.startsWith("https://api.github.com/repos/acme/deferred/git/trees/main")) {
        return {
          truncated: false,
          tree: [
            { path: "SKILL.md", type: "blob", sha: "sha-skill", size: skillMd.length },
            { path: "scripts/run.py", type: "blob", sha: "sha-script", size: 11 },
            { path: "assets/logo.png", type: "blob", sha: "sha-png", size: 40000 }
          ]
        };
      }
      const m = /\/git\/blobs\/(.+)$/.exec(url);
      if (m && blobs[m[1]]) {
        return { encoding: "base64", content: blobs[m[1]] };
      }
      throw new Error(`unexpected url: ${url} (png should not be fetched at install)`);
    };

    const result = await installSkillFromGitHub({
      source: "acme/deferred",
      skillsRoot: paths.skillsRoot,
      deps: { fetchJson }
    });

    expect(result.coreFiles).toBe(2);
    expect(result.deferredFiles).toBe(1);
    expect(result.files).toEqual(["SKILL.md", "scripts/run.py"]);

    const installDir = result.installPath;
    expect(existsSync(path.join(installDir, "scripts/run.py"))).toBe(true);
    expect(existsSync(path.join(installDir, "assets/logo.png"))).toBe(false);

    const manifest = readSkillManifest(installDir);
    expect(manifest?.source.resolvedRef).toBe("main");
    expect(manifest?.deferred.map((e) => e.path)).toEqual(["assets/logo.png"]);
  });

  it("reports honestly when core exceeds the file limit instead of guessing", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);

    const skillMd = "---\nname: huge\n---\n";
    const tree = [{ path: "SKILL.md", type: "blob", sha: "sha-skill", size: skillMd.length }];
    for (let i = 0; i < 10; i++) {
      tree.push({ path: `frag/f${i}.md`, type: "blob", sha: `sha-${i}`, size: 100 });
    }
    const fetchJson = async (url: string): Promise<unknown> => {
      if (url === "https://api.github.com/repos/acme/huge") {
        return { default_branch: "main" };
      }
      if (url.startsWith("https://api.github.com/repos/acme/huge/git/trees/main")) {
        return { truncated: false, tree };
      }
      throw new Error(`unexpected url: ${url}`);
    };

    await expect(
      installSkillFromGitHub({
        source: "acme/huge",
        skillsRoot: paths.skillsRoot,
        maxFiles: 5,
        deps: { fetchJson }
      })
    ).rejects.toThrow(/core has 11 files/);
  });
});

describe("materialize deferred files", () => {
  const writeInstalledSkill = (skillDir: string): void => {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: m\n---\n", "utf8");
    writeSkillManifest(
      skillDir,
      buildSkillManifest({
        source: { owner: "acme", repo: "pack", resolvedRef: "feedface", subdir: "" },
        core: [{ path: "SKILL.md", sha: "sha-skill", size: 16 }],
        deferred: [
          { path: "templates/a.svg", sha: "sha-a", size: 10 },
          { path: "templates/b.svg", sha: "sha-b", size: 10 },
          { path: "assets/logo.png", sha: "sha-png", size: 40000 }
        ]
      })
    );
  };

  const blobFetch =
    (blobs: Record<string, string>) =>
    async (url: string): Promise<unknown> => {
      const m = /\/git\/blobs\/(.+)$/.exec(url);
      if (m && blobs[m[1]]) {
        return { encoding: "base64", content: blobs[m[1]] };
      }
      throw new Error(`unexpected url: ${url}`);
    };

  it("materializes deferred files matching a glob, using the pinned sha", async () => {
    temp = makeTempRoot();
    const skillDir = path.join(temp.path, "m");
    writeInstalledSkill(skillDir);

    const result = await materializeSkillFiles({
      skillDir,
      pattern: "templates/*",
      deps: {
        fetchJson: blobFetch({ "sha-a": b64("<svg a>"), "sha-b": b64("<svg b>") })
      }
    });

    expect(result.materialized).toEqual(["templates/a.svg", "templates/b.svg"]);
    expect(readFileSync(path.join(skillDir, "templates/a.svg"), "utf8")).toBe("<svg a>");
    expect(existsSync(path.join(skillDir, "assets/logo.png"))).toBe(false);
  });

  it("skips already-present files unless forced", async () => {
    temp = makeTempRoot();
    const skillDir = path.join(temp.path, "m");
    writeInstalledSkill(skillDir);
    mkdirSync(path.join(skillDir, "templates"), { recursive: true });
    writeFileSync(path.join(skillDir, "templates/a.svg"), "old", "utf8");

    const result = await materializeSkillFiles({
      skillDir,
      pattern: "templates/a.svg",
      deps: { fetchJson: blobFetch({ "sha-a": b64("new") }) }
    });
    expect(result.materialized).toEqual([]);
    expect(result.skipped).toEqual(["templates/a.svg"]);
    expect(readFileSync(path.join(skillDir, "templates/a.svg"), "utf8")).toBe("old");
  });

  it("throws when the skill has no manifest", async () => {
    temp = makeTempRoot();
    const skillDir = path.join(temp.path, "legacy");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "# Legacy", "utf8");

    await expect(
      materializeSkillFiles({ skillDir, deps: { fetchJson: blobFetch({}) } })
    ).rejects.toBeInstanceOf(SkillMaterializeError);
  });

  it("materializeDeferredPath resolves one deferred file and ignores unknown paths", async () => {
    temp = makeTempRoot();
    const skillDir = path.join(temp.path, "m");
    writeInstalledSkill(skillDir);

    const resolved = await materializeDeferredPath({
      skillDir,
      relPath: "templates/b.svg",
      deps: { fetchJson: blobFetch({ "sha-b": b64("<svg b>") }) }
    });
    expect(resolved).toBe(path.join(skillDir, "templates/b.svg"));
    expect(readFileSync(resolved!, "utf8")).toBe("<svg b>");

    const unknown = await materializeDeferredPath({
      skillDir,
      relPath: "not/in/manifest.md",
      deps: { fetchJson: blobFetch({}) }
    });
    expect(unknown).toBeUndefined();
  });
});
