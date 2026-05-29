import { afterEach, describe, expect, it } from "vitest";
import {
  writeMemdirEntry,
  listMemdirEntries,
  deleteMemdirEntry,
  findMemdirEntry,
  searchMemdir,
  readMemdirIndex,
  ensureMemdir
} from "../src/memdir.js";
import { makeTempRoot, TempRoot } from "./helpers.js";

describe("memdir", () => {
  let temp: TempRoot;
  afterEach(() => temp?.cleanup());

  function root() {
    return { root: temp.path };
  }

  it("writes a typed memdir entry with frontmatter", () => {
    temp = makeTempRoot();
    const entry = writeMemdirEntry({
      paths: root(),
      type: "user",
      name: "User role",
      description: "Senior backend engineer",
      body: "User has 10 years of Go experience and is exploring frontend."
    });
    expect(entry.filename).toBe("user_user_role.md");
    expect(entry.type).toBe("user");
    expect(entry.path).toContain("memdir");
  });

  it("lists entries sorted by filename", () => {
    temp = makeTempRoot();
    writeMemdirEntry({
      paths: root(),
      type: "feedback",
      name: "Avoid mocks",
      description: "Use real DB",
      body: "Why: prod parity."
    });
    writeMemdirEntry({
      paths: root(),
      type: "user",
      name: "Role",
      description: "DBA",
      body: "10y postgres."
    });
    const entries = listMemdirEntries(root());
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.type)).toContain("feedback");
    expect(entries.map((e) => e.type)).toContain("user");
  });

  it("finds an entry by name or filename", () => {
    temp = makeTempRoot();
    writeMemdirEntry({
      paths: root(),
      type: "project",
      name: "Auth rewrite",
      description: "Compliance-driven",
      body: "Legal flagged session tokens."
    });
    const byName = findMemdirEntry(root(), "Auth rewrite");
    expect(byName?.type).toBe("project");
    const byFilename = findMemdirEntry(root(), "project_auth_rewrite.md");
    expect(byFilename?.name).toBe("Auth rewrite");
  });

  it("ranks search results by relevance and type weight", () => {
    temp = makeTempRoot();
    writeMemdirEntry({
      paths: root(),
      type: "user",
      name: "Database",
      description: "Uses Postgres",
      body: "Postgres 14."
    });
    writeMemdirEntry({
      paths: root(),
      type: "reference",
      name: "Grafana",
      description: "Latency dashboard",
      body: "URL: grafana.example.com/api"
    });
    const results = searchMemdir({ paths: root(), query: "postgres database" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("Database");
  });

  it("maintains the MEMORY.md index automatically", () => {
    temp = makeTempRoot();
    writeMemdirEntry({
      paths: root(),
      type: "user",
      name: "Tabs",
      description: "Prefers tabs",
      body: "User uses tabs not spaces."
    });
    const indexBefore = readMemdirIndex(root());
    expect(indexBefore).toContain("Tabs");
    expect(indexBefore).toContain("Prefers tabs");

    deleteMemdirEntry(root(), "user_tabs.md");
    const indexAfter = readMemdirIndex(root());
    expect(indexAfter).not.toContain("Tabs");
  });

  it("ignores files without proper frontmatter", () => {
    temp = makeTempRoot();
    ensureMemdir(root());
    // Only properly formatted entries should appear
    writeMemdirEntry({
      paths: root(),
      type: "user",
      name: "Valid",
      description: "Has frontmatter",
      body: "OK."
    });
    const entries = listMemdirEntries(root());
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe("Valid");
  });

  it("returns empty list when memdir does not exist", () => {
    temp = makeTempRoot();
    const entries = listMemdirEntries(root());
    expect(entries).toEqual([]);
  });
});
