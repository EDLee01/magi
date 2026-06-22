#!/usr/bin/env node

import { existsSync } from "node:fs";
import { chromium } from "playwright";

const failures = [];
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

if (nodeMajor < 22) {
  failures.push(`Node 22 or newer is required; found ${process.versions.node}`);
}

const chromiumPath = chromium.executablePath();
if (!existsSync(chromiumPath)) {
  failures.push(
    `Playwright Chromium is missing at ${chromiumPath}. Run: npx playwright install chromium`
  );
}

if (failures.length > 0) {
  console.error(
    ["Magi verification preflight failed:", ...failures.map((item) => `- ${item}`)].join("\n")
  );
  process.exit(1);
}

console.log(`Preflight passed: Node ${process.versions.node}, Chromium ${chromiumPath}`);
