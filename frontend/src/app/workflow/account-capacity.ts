import type { TradingAccount } from "./types";

const ACTIVE_POSITION_STATUSES = new Set([
  "opening",
  "open",
  "closing",
  "emergency",
]);

export function accountCapacity(
  account: TradingAccount,
  positions: ReadonlyArray<Record<string, unknown>>,
): { active: number; maximum: number; full: boolean } {
  const active = positions.reduce((count, position) => (
    position.accountId === account.id
      && typeof position.status === "string"
      && ACTIVE_POSITION_STATUSES.has(position.status)
      ? count + 1
      : count
  ), 0);
  const maximum = account.maxConcurrentPositions;
  return { active, maximum, full: active >= maximum };
}

export function formatAccountCapacitySummary(
  account: TradingAccount,
  positions: ReadonlyArray<Record<string, unknown>>,
): string {
  const capacity = accountCapacity(account, positions);
  return capacity.full
    ? `${account.exchange} · ${account.mode} · ${capacity.active}/${capacity.maximum} · VOLL`
    : `${account.exchange} · ${account.mode} · ${capacity.active}/${capacity.maximum} aktiv`;
}
