#!/usr/bin/env bash
set -euo pipefail

npm test

rm -rf data
mkdir -p data
printf '[]\n' > data/notes.json

node src/cli.js add --title "Dry note" --dry-run > dry-run.txt

node - <<'NODE'
const { readFileSync } = require("node:fs");
const cli = readFileSync("src/cli.js", "utf8");
const store = readFileSync("src/store.js", "utf8");
const readme = readFileSync("README.md", "utf8");
const tests = readFileSync("tests/cli.test.mjs", "utf8");
const data = readFileSync("data/notes.json", "utf8");
const output = readFileSync("dry-run.txt", "utf8");

if (!cli.includes("--dry-run")) throw new Error("CLI help is missing --dry-run");
if (!store.includes("dryRun")) throw new Error("store API does not expose dryRun");
if (!readme.includes("--dry-run")) throw new Error("README is missing dry-run usage");
if (!tests.includes("dry-run does not write")) throw new Error("dry-run test was not added");
if (data.trim() !== "[]") throw new Error("dry-run modified data/notes.json");
if (!output.includes("[dry-run] Would add note: Dry note")) {
  throw new Error("dry-run output was not explicit");
}
NODE

rm -f dry-run.txt
rm -rf data
