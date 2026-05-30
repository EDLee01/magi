#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCapabilityReportFromFiles,
  formatCapabilityReport,
  writeCapabilityReport
} from "../dist/capability-report.js";
import {
  appendCapabilityTrendHistory,
  buildCapabilityTrendReport,
  formatCapabilityTrendReport,
  readCapabilityTrendOptions,
  readCapabilityTrendHistory,
  writeCapabilityTrendReport
} from "../dist/capability-trend.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliOptions = parseArgs(process.argv.slice(2));
const reportsRoot = path.join(repoRoot, ".magi-reports");
const outputPath =
  process.env.MAGI_CAPABILITY_REPORT ??
  path.join(reportsRoot, "capability-alignment-report.json");
const trendOutputPath =
  process.env.MAGI_CAPABILITY_TREND_REPORT ??
  path.join(reportsRoot, "capability-trend-report.json");
const trendHistoryPath =
  process.env.MAGI_CAPABILITY_TREND_HISTORY ??
  path.join(reportsRoot, "capability-trend-history.json");

const report = buildCapabilityReportFromFiles({ repoRoot, reportsRoot });
writeCapabilityReport(outputPath, report);
const trend = buildCapabilityTrendReport({
  current: report,
  history: readCapabilityTrendHistory(trendHistoryPath),
  ...readCapabilityTrendOptions({ profile: cliOptions.profile, env: process.env })
});
writeCapabilityTrendReport(trendOutputPath, trend);

if (report.status !== "passed" || trend.status !== "passed") {
  console.error(formatCapabilityReport(report));
  console.error(formatCapabilityTrendReport(trend));
  process.exit(1);
}

appendCapabilityTrendHistory({ file: trendHistoryPath, report: trend });

console.log(formatCapabilityReport(report));
console.log(formatCapabilityTrendReport(trend));
console.log(`Capability report: ${outputPath}`);
console.log(`Capability trend report: ${trendOutputPath}`);

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--profile") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--profile requires ci or nightly");
      }
      options.profile = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown capability-report option: ${arg}`);
  }
  return options;
}
