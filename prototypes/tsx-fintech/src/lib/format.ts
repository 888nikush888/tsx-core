export function eur(value: number, digits = 2): string {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR",
    minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
}
export function usd(value: number, digits = 2): string {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "USD",
    minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
}
export function num(value: number, digits = 2): string {
  return new Intl.NumberFormat("de-DE", { minimumFractionDigits: digits,
    maximumFractionDigits: digits }).format(value)
}
export function pct(value: number, digits = 2): string {
  return new Intl.NumberFormat("de-DE", { style: "percent",
    minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
}
export function dt(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short",
    timeZone: "Europe/Berlin" }).format(new Date(value))
}
export function time(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit",
    second: "2-digit", timeZone: "Europe/Berlin" }).format(new Date(value))
}
