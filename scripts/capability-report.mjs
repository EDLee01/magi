#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCapabilityReportFromFiles,
  formatCapabilityReport,
  writeCapabilityReport
} from "../dist/capability-report.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportsRoot = path.join(repoRoot, ".magi-reports");
const outputPath =
  process.env.MAGI_CAPABILITY_REPORT ??
  path.join(reportsRoot, "capability-alignment-report.json");

const report = buildCapabilityReportFromFiles({ repoRoot, reportsRoot });
writeCapabilityReport(outputPath, report);

if (report.status !== "passed") {
  console.error(formatCapabilityReport(report));
  process.exit(1);
}

console.log(formatCapabilityReport(report));
console.log(`Capability report: ${outputPath}`);
