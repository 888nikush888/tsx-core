export type AnalyticsRange = "24h" | "7d" | "30d" | "90d" | "all" | "custom";
export function analyticsQuery(filters: {
  range: AnalyticsRange; customFrom: string; customUntil: string;
  channelId: string; accountId: string; exchange: string; mode: string; status: string;
}, now: number): string {
  const durations = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, "90d": 90 * 86_400_000 };
  const since = filters.range === "all" ? 0 : filters.range === "custom" ? new Date(filters.customFrom).getTime() : now - durations[filters.range];
  const until = filters.range === "custom" ? new Date(filters.customUntil).getTime() : now;
  if (!Number.isFinite(since) || !Number.isFinite(until) || since > until) throw new Error("Gültigen, aufsteigenden Zeitraum wählen.");
  const query = new URLSearchParams({ since: String(since), until: String(until) });
  for (const key of ["channelId", "accountId", "exchange", "mode", "status"] as const) if (filters[key]) query.set(key, filters[key]);
  return query.toString();
}
