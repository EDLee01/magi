#!/usr/bin/env bash
set -euo pipefail

node - <<'NODE'
const { readFileSync } = require("node:fs");
const value = readFileSync("output/automation-result.txt", "utf8");
if (value !== "stream-json automation ok\n") {
  throw new Error(`unexpected automation result: ${JSON.stringify(value)}`);
}
NODE
