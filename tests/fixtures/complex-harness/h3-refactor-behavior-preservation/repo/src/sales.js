function parseSalesAmounts(input) {
  return input
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number(value));
}

function salesReport(input) {
  const amounts = parseSalesAmounts(input);
  const total = amounts.reduce((sum, value) => sum + value, 0);
  return `sales total=${total}; count=${amounts.length}`;
}

module.exports = { salesReport, parseSalesAmounts };
