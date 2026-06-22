import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

if (packageJson.bin && Object.prototype.hasOwnProperty.call(packageJson.bin, "magi-agent")) {
  throw new Error("package.json must not publish a magi-agent binary");
}

const productionRoots = ["src"];
const forbiddenRuntimeNeedles = [
  "/home/claude-user/magi",
  "Claude Web/OAuth",
  "Claude in Chrome",
  "Anthropic remote bridge",
  "official Claude plugin marketplace"
];

function filesUnder(dir) {
  const abs = path.join(root, dir);
  const entries = [];
  for (const name of readdirSync(abs)) {
    const item = path.join(abs, name);
    const stat = statSync(item);
    if (stat.isDirectory()) {
      entries.push(...filesUnder(path.relative(root, item)));
    } else {
      entries.push(item);
    }
  }
  return entries;
}

for (const file of productionRoots.flatMap(filesUnder)) {
  const text = readFileSync(file, "utf8");
  for (const needle of forbiddenRuntimeNeedles) {
    if (text.includes(needle)) {
      throw new Error(
        `Forbidden clean-room runtime reference ${JSON.stringify(needle)} in ${file}`
      );
    }
  }
  if (/\bexecSync\s*\(\s*`/.test(text)) {
    throw new Error(`Dynamic or template-string execSync is forbidden in ${file}; use argv APIs`);
  }
  if (/\bexecSync\s*\(\s*[A-Za-z_$][A-Za-z0-9_$]*\s*[,)]/.test(text)) {
    throw new Error(`Variable-driven execSync is forbidden in ${file}; use argv APIs`);
  }
  if (/\bshell\s*:\s*true\b/.test(text)) {
    throw new Error(`shell: true is forbidden in ${file}; use an explicit reviewed shell boundary`);
  }
}
