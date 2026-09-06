

export function resolveDisplayedLeverage(plan: {
  leverage?: unknown;
  leverageDecision?: { effective?: unknown } | null;
} | null | undefined): number | null {
  const decided = Number(plan?.leverageDecision?.effective);
  if (Number.isFinite(decided) && decided > 0) return decided;
  const legacy = Number(plan?.leverage);
  return Number.isFinite(legacy) && legacy > 0 ? legacy : null;
}
