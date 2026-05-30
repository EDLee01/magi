#!/usr/bin/env bash
set -euo pipefail

npm test

node - <<'NODE'
const { readFileSync } = require("node:fs");
const source = readFileSync("src/discount.ts", "utf8");
if (!source.includes("return total - total * percent;")) {
  throw new Error("discount formula was not fixed");
}
if (source.includes("return total - percent;")) {
  throw new Error("stale discount formula remains");
}
NODE
