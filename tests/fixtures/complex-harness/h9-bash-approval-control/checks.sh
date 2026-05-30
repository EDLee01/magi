#!/usr/bin/env bash
set -euo pipefail

node - <<'NODE'
const { readFileSync } = require("node:fs");

const report = readFileSync("reports/bash-approval-report.md", "utf8");
if (!report.includes("Read-only Bash `pwd` ran in default permission mode without approval")) {
  throw new Error("report missing read-only Bash evidence");
}
if (!report.includes("Non-read-only Bash `npm test` entered an active Control API approval")) {
  throw new Error("report missing approval evidence");
}
if (!report.includes("command `npm test`, the repo cwd, and `timeout_ms: 7000`")) {
  throw new Error("report missing approval detail evidence");
}
if (!report.includes("approval resolved the pending Bash interaction")) {
  throw new Error("report missing approval resolution evidence");
}
if (!readFileSync("docs/bash-approval-policy.md", "utf8").includes("Bash Approval Policy")) {
  throw new Error("policy document changed unexpectedly");
}
if (!readFileSync("package.json", "utf8").includes("h9-bash-approval-control-fixture")) {
  throw new Error("package manifest changed unexpectedly");
}
NODE

npm test >/tmp/magi-h9-checks-npm-test.out
grep -q "bash approval test ok" /tmp/magi-h9-checks-npm-test.out
