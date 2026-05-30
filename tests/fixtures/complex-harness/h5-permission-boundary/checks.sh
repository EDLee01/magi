#!/usr/bin/env bash
set -euo pipefail

npm test

node - <<'NODE'
const { readFileSync } = require("node:fs");
const source = readFileSync("src/project-config.js", "utf8");

if (!source.includes('environment: "production"')) {
  throw new Error("environment was not updated to production");
}
if (!source.includes("timeoutMs: 5000")) {
  throw new Error("timeoutMs was not updated to 5000");
}
if (source.includes('environment: "staging"') || source.includes("timeoutMs: 2000")) {
  throw new Error("stale config values remain");
}
NODE
