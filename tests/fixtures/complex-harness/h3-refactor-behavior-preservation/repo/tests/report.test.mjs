import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { salesReport } = await import("../src/sales.js");
const { inventoryReport } = await import("../src/inventory.js");

const snapshot = [
  salesReport("10, 20,30"),
  salesReport(" 5,, 15 "),
  inventoryReport("3, 7,10"),
  inventoryReport(" 1,, 2 ")
].join("\n");

const expected = [
  "sales total=60; count=3",
  "sales total=20; count=2",
  "inventory total=20; count=3",
  "inventory total=3; count=2"
].join("\n");

assert.equal(snapshot, expected);
assert.match(readFileSync("src/sales.js", "utf8"), /parseSalesAmounts/);
assert.match(readFileSync("src/inventory.js", "utf8"), /parseInventoryCounts/);

console.log(snapshot);
console.log("report tests passed");
