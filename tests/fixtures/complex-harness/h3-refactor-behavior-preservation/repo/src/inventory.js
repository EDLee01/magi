function parseInventoryCounts(input) {
  return input
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number(value));
}

function inventoryReport(input) {
  const counts = parseInventoryCounts(input);
  const total = counts.reduce((sum, value) => sum + value, 0);
  return `inventory total=${total}; count=${counts.length}`;
}

module.exports = { inventoryReport, parseInventoryCounts };
