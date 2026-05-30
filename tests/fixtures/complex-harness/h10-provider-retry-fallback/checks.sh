#!/usr/bin/env bash
set -euo pipefail

node - <<'NODE'
const { readFileSync } = require("node:fs");

const report = readFileSync("reports/provider-retry-report.md", "utf8");
if (!report.includes("Primary provider produced three retryable server failures")) {
  throw new Error("report missing primary retry evidence");
}
if (!report.includes("provider.retry events instead of session.error")) {
  throw new Error("report missing retry event evidence");
}
if (!report.includes("Fallback switched to backup/mock-backup")) {
  throw new Error("report missing backup fallback evidence");
}
if (!readFileSync("docs/provider-retry.md", "utf8").includes("Provider Retry Policy")) {
  throw new Error("provider retry policy changed unexpectedly");
}
NODE
