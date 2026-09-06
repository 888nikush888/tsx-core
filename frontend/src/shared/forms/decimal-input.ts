/** Canonical decimal transport; grouping separators and mixed formats are intentionally rejected. */
export function decimalInput(value: string): string {
  const trimmed = value.trim();
  if (!/^\d+(?:[.,]\d+)?$/.test(trimmed)) throw new Error("Dezimalzahl ohne Tausendertrennzeichen eingeben, z. B. 1234,50 oder 1234.50.");
  return trimmed.replace(",", ".");
}
