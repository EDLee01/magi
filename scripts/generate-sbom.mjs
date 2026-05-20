import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const components = [];

for (const [packagePath, info] of Object.entries(lock.packages ?? {})) {
  if (!packagePath.startsWith("node_modules/")) {
    continue;
  }
  const name = packagePath.replace(/^node_modules\//, "");
  components.push({
    type: "library",
    name,
    version: info.version ?? "unknown",
    purl: `pkg:npm/${encodeURIComponent(name)}@${info.version ?? "unknown"}`
  });
}

components.sort((a, b) => a.name.localeCompare(b.name));

const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: "application",
      name: packageJson.name,
      version: packageJson.version
    }
  },
  components
};

writeFileSync(path.join(root, "docs", "sbom.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
console.log(`SBOM generated with ${components.length} components`);
