#!/usr/bin/env bash
set -euo pipefail

node - <<'NODE'
const { readFileSync } = require("node:fs");

const report = readFileSync("reports/agent-conflict-report.md", "utf8");
if (!report.includes("Disjoint worker write claims succeeded")) {
  throw new Error("report missing disjoint claim success");
}
if (!report.includes("Both disjoint worker tasks reached `completed` status")) {
  throw new Error("report missing completed task status");
}
if (!report.includes("Write conflict for src/left.txt")) {
  throw new Error("report missing same-file conflict");
}
if (readFileSync("src/left.txt", "utf8") !== "left baseline\n") {
  throw new Error("left source file changed");
}
if (readFileSync("src/right.txt", "utf8") !== "right baseline\n") {
  throw new Error("right source file changed");
}
NODE
