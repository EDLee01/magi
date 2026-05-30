#!/usr/bin/env bash
set -euo pipefail

npm test

node - <<'NODE'
const { readFileSync } = require("node:fs");
const sales = readFileSync("src/sales.js", "utf8");
const inventory = readFileSync("src/inventory.js", "utf8");
const parse = readFileSync("src/parse.js", "utf8");

if (!parse.includes("function parseCsvNumbers")) {
  throw new Error("shared parseCsvNumbers helper was not created");
}
if (!sales.includes('require("./parse")')) {
  throw new Error("sales does not use shared parse helper");
}
if (!inventory.includes('require("./parse")')) {
  throw new Error("inventory does not use shared parse helper");
}
if (sales.includes("split(\",\")") || inventory.includes("split(\",\")")) {
  throw new Error("duplicate comma parsing remains in source modules");
}
NODE
