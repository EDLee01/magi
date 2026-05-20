import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const packages = lock.packages ?? {};
const denied = new Set(["GPL-2.0", "GPL-3.0", "AGPL-1.0", "AGPL-3.0"]);
const report = [];

for (const [packagePath, info] of Object.entries(packages)) {
  if (!packagePath.startsWith("node_modules/")) {
    continue;
  }
  const name = packagePath.replace(/^node_modules\//, "");
  const license = readLicense(name, info);
  report.push({
    name,
    version: info.version ?? "unknown",
    license
  });
  if (denied.has(license)) {
    throw new Error(`Denied dependency license ${license} found in ${name}`);
  }
}

report.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(
  path.join(root, "docs", "license-report.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), packages: report }, null, 2)}\n`,
  "utf8"
);
console.log(`License scan passed for ${report.length} packages`);

function readLicense(name, lockInfo) {
  const packageJsonPath = path.join(root, "node_modules", name, "package.json");
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (typeof packageJson.license === "string") {
      return packageJson.license;
    }
    if (Array.isArray(packageJson.licenses) && packageJson.licenses[0]?.type) {
      return String(packageJson.licenses[0].type);
    }
  } catch {
    // package-lock metadata is the fallback below.
  }
  return typeof lockInfo.license === "string" ? lockInfo.license : "UNKNOWN";
}
