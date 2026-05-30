import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { invoiceSummary, invoiceTotal } = require("../src/invoice.js");

const lines = [
  { sku: "A", quantity: 3, unitPrice: 10 },
  { sku: "B", quantity: 2, unitPrice: 5 }
];

assert.equal(invoiceTotal(lines), 40);
assert.deepEqual(invoiceSummary(lines), { lineCount: 2, total: 40 });

console.log("invoice tests passed");
