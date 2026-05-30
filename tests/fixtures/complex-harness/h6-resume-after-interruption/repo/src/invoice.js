function invoiceTotal(lines) {
  return lines.reduce((total, line) => total + line.unitPrice, 0);
}

function invoiceSummary(lines) {
  return {
    lineCount: lines.length,
    total: invoiceTotal(lines)
  };
}

module.exports = { invoiceSummary, invoiceTotal };
