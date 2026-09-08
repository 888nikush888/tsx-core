export function normalizeJournalSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replaceAll("/", "");
}
export function buildJournalQueryString(filters: {
  from: string; to: string; channelId: string; accountId: string; symbol: string; status: string; reviewed?: string;
}): string {
  const params = new URLSearchParams({ limit: "50" });
  if (filters.from) params.set("from", String(new Date(`${filters.from}T00:00:00`).getTime()));
  if (filters.to) params.set("to", String(new Date(`${filters.to}T23:59:59.999`).getTime()));
  for (const key of ["channelId", "accountId", "status", "reviewed"] as const) if (filters[key]) params.set(key, filters[key]);
  const symbol = normalizeJournalSymbol(filters.symbol);
  if (symbol) params.set("symbol", symbol);
  return params.toString();
}
