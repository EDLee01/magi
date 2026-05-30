import assert from "node:assert/strict";
import { rmSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

rmSync("data", { recursive: true, force: true });

let result = spawnSync(process.execPath, ["src/cli.js", "add", "--title", "First"], {
  encoding: "utf8"
});
assert.equal(result.status, 0);
assert.match(result.stdout, /Added note #1: First/);

result = spawnSync(process.execPath, ["src/cli.js", "list"], { encoding: "utf8" });
assert.equal(result.status, 0);
assert.match(result.stdout, /#1 First/);

assert.equal(existsSync("data/notes.json"), true);
assert.match(readFileSync("data/notes.json", "utf8"), /First/);

console.log("notes cli tests passed");
