import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/discount.ts", import.meta.url), "utf8")
  .replace("export function", "function")
  .replace(": number, percent: number", ", percent")
  .replace("): number", ")");
const applyDiscount = Function(`${source}\nreturn applyDiscount;`)();

assert.equal(applyDiscount(100, 0.1), 90);
assert.equal(applyDiscount(250, 0.2), 200);
assert.throws(() => applyDiscount(100, 1.2), /between 0 and 1/);

console.log("discount tests passed");
