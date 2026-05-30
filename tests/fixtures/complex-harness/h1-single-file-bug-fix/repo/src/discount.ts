export function applyDiscount(total: number, percent: number): number {
  if (percent < 0 || percent > 1) {
    throw new Error("percent must be between 0 and 1");
  }
  return total - percent;
}
