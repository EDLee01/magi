#!/usr/bin/env bash
set -euo pipefail

npm test

node - <<'NODE'
const { readFileSync } = require("node:fs");
const source = readFileSync("src/invoice.js", "utf8");
const report = readFileSync("reports/invoice-investigation.md", "utf8");

if (!source.includes("line.quantity * line.unitPrice")) {
  throw new Error("invoice total should multiply quantity by unit price");
}
if (source.includes("total + line.unitPrice;")) {
  throw new Error("stale invoice total bug remains");
}
if (!report.includes("quantity is ignored") || !report.includes("expected 40 but received 25")) {
  throw new Error("investigation report did not preserve failing case");
}
NODE
