import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const ignoredDirs = new Set(["node_modules", "dist", ".git", "coverage"]);
const secretPatterns = [
  { name: "OpenAI API key", pattern: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: "GitHub token", pattern: /gh[pousr]_[A-Za-z0-9_]{20,}/ },
  { name: "private key block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/ }
];

const findings = [];
for (const file of filesUnder(root)) {
  const text = readFileSync(file, "utf8");
  for (const { name, pattern } of secretPatterns) {
    if (pattern.test(text)) {
      findings.push(`${path.relative(root, file)}: ${name}`);
    }
  }
}

if (findings.length > 0) {
  throw new Error(`Secret scan failed:\n${findings.join("\n")}`);
}

console.log("Secret scan passed");

function filesUnder(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    if (ignoredDirs.has(name)) {
      continue;
    }
    const item = path.join(dir, name);
    const stat = statSync(item);
    if (stat.isDirectory()) {
      entries.push(...filesUnder(item));
    } else if (stat.isFile() && stat.size < 1024 * 1024) {
      entries.push(item);
    }
  }
  return entries;
}
