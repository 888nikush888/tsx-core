/** Presentation only. Trading decisions use the server's original-evidence MoneyValue contract. */
export interface DisplayMoneyValue {
  lower: string; upper: string;
  exact: { numerator: string; denominator: string } | null;
  decimal: string | null; precision: "exact_decimal" | "exact_rational" | "bounded"; terms: number;
}
export interface DisplayMoney {
  value?: unknown; amount?: unknown; currency?: unknown; status?: unknown;
}
const decimalText = (value: unknown): value is string => typeof value === "string"
  && /^-?(?:0|[1-9][0-9]{0,35})(?:\.[0-9]{1,18})?$/.test(value);
const DECIMAL_SCALE = 10n ** 18n;
function decimalUnits(value: string): bigint {
  const [integer, fraction = ""] = value.replace(/^-/, "").split(".");
  const units = BigInt(integer + fraction.padEnd(18, "0"));
  return value.startsWith("-") ? -units : units;
}
function displayValue(value: unknown): DisplayMoneyValue | null {
  if (!value || typeof value !== "object") return null;
  const row = value as DisplayMoneyValue;
  if (!decimalText(row.lower) || !decimalText(row.upper) || !Number.isSafeInteger(row.terms) || row.terms < 0) return null;
  const lower = decimalUnits(row.lower), upper = decimalUnits(row.upper);
  if (lower > upper) return null;
  if (row.precision === "bounded") return row.exact === null && row.decimal === null ? row : null;
  if (!row.exact || typeof row.exact.numerator !== "string" || typeof row.exact.denominator !== "string"
    || !/^-?(?:0|[1-9][0-9]{0,255})$/.test(row.exact.numerator)
    || !/^[1-9][0-9]{0,255}$/.test(row.exact.denominator)) return null;
  const numerator = BigInt(row.exact.numerator) * DECIMAL_SCALE, denominator = BigInt(row.exact.denominator);
  if (numerator < lower * denominator || numerator > upper * denominator) return null;
  if (row.precision === "exact_decimal" && decimalText(row.decimal)) {
    const units = decimalUnits(row.decimal);
    return lower === units && upper === units && numerator === units * denominator ? row : null;
  }
  return row.precision === "exact_rational" && row.decimal === null ? row : null;
}
const locale = (value: string) => value.replace(".", ",");
function unit(currency: unknown): string {
  return typeof currency === "string" && /^[A-Z0-9]{2,12}$/.test(currency) ? ` ${currency}` : "";
}
function approximation(value: DisplayMoneyValue): string {
  const numerator = BigInt(value.exact!.numerator), denominator = BigInt(value.exact!.denominator);
  const magnitude = numerator < 0n ? -numerator : numerator;
  const units = magnitude * 1_000_000n / denominator;
  if (units === 0n && numerator !== 0n) return `${numerator < 0n ? "negativ" : "positiv"} (< 0,000001)`;
  const digits = units.toString().padStart(7, "0");
  const text = `${digits.slice(0, -6)},${digits.slice(-6)}`.replace(/0+$/, "").replace(/,$/, "");
  return `≈ ${numerator < 0n ? "−" : ""}${text}`;
}
export function moneyDisplay(input: DisplayMoney): { label: string; detail: string; uncertain: boolean } {
  if (["unresolved", "incomplete", "not_proven"].includes(String(input.status))) {
    return { label: "Bewertung ungeklärt", detail: "Fehlende oder widersprüchliche Geldbelege; kein Nullbetrag.", uncertain: true };
  }
  const suffix = unit(input.currency), value = displayValue(input.value);
  if (input.value !== null && input.value !== undefined && !value) {
    return { label: "Bewertung ungeklärt", detail: "Ungültiger Geldwert; kein Ersatz durch einen gerundeten Betrag.", uncertain: true };
  }
  if (value?.precision === "bounded") {
    return { label: `[${locale(value.lower)}; ${locale(value.upper)}]${suffix} (Grenzen)`,
      detail: "Konservative Unter- und Obergrenze; kein exakter Einzelbetrag.", uncertain: true };
  }
  if (value) return { label: `${value.decimal === null ? approximation(value) : locale(value.decimal)}${suffix}`,
    detail: `Exakt: ${value.exact!.numerator}/${value.exact!.denominator}${suffix}`, uncertain: false };
  if (decimalText(input.amount)) return { label: `${locale(input.amount)}${suffix}`, detail: `Exakt: ${input.amount}${suffix}`, uncertain: false };
  // Compatibility with older display-only analytics responses; never feeds a risk calculation.
  if (typeof input.amount === "number" && Number.isFinite(input.amount)) return {
    label: `${input.amount.toLocaleString("de-DE", { maximumFractionDigits: 6 })}${suffix}`,
    detail: "Historischer numerischer Anzeigewert, kein exakter Geldbeleg.", uncertain: true };
  return { label: "Bewertung ungeklärt", detail: "Kein bewerteter Betrag vorhanden; unabhängig vom Positionsstatus.", uncertain: true };
}

/** Recharts uses floating-point display coordinates, never monetary sums or ranking decisions. */
export function moneyChartGroups(rows: Array<Record<string, any>>): Array<{ currency: string; points: Array<Record<string, any>> }> {
  const groups = new Map<string, Array<Record<string, any>>>();
  for (const row of rows) {
    if (!unit(row.reportingCurrency) || row.accountingStatus !== "complete") continue;
    const value = displayValue(row.realizedPnlValue);
    if (!value?.exact) continue; // No synthetic zero for unresolved/bounded or old unproved graph points.
    const chartPnl = Number(value.exact.numerator) / Number(value.exact.denominator);
    if (!Number.isFinite(chartPnl) || (chartPnl === 0 && BigInt(value.exact.numerator) !== 0n)) continue;
    const points = groups.get(row.reportingCurrency) ?? [];
    points.push({ ...row, chartPnl }); groups.set(row.reportingCurrency, points);
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([currency, points]) => ({ currency, points }));
}
