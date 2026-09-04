import type { ExchangeRecoveryQuery, ExchangeHistoryCheckpoint } from './trading_types.js';
import type { FxEvidenceRequest, RecoveryScheduleBinding, RecoveryScheduleRequest, RecoveryLane } from './trading_recovery_schedule_contract.js';

export type ScheduledRecoveryQuery = ExchangeRecoveryQuery & { recoverySchedule: RecoveryScheduleRequest; fxEvidence?: FxEvidenceRequest };
export interface RecoveryScheduleState {
  id: string; revision: number; phase: 0 | 1 | 2 | 3; fx_rotation: number; logs_first: number;
  history_after: string | null; next_due_at: number; cooldown_until: number;
}
const LEG_ROTATIONS: FxEvidenceRequest['legIds'][] = [
  ['bybit:btc-usd-index:v1', 'bybit:btc-usdt-index:v1', 'bybit:usdc-usd-index:v1'],
  ['bybit:usdc-usd-index:v1', 'bybit:btc-usd-index:v1', 'bybit:btc-usdt-index:v1'],
  ['bybit:btc-usdt-index:v1', 'bybit:btc-usd-index:v1', 'bybit:usdc-usd-index:v1'],
  ['bybit:usdc-usd-index:v1', 'bybit:btc-usdt-index:v1', 'bybit:btc-usd-index:v1'],
];
export function recoveryHistoryKey(row: ExchangeHistoryCheckpoint): string { return JSON.stringify([row.source, row.providerSymbol]); }
function nextHistory(query: ExchangeRecoveryQuery, previous: string | null, now: number): ExchangeHistoryCheckpoint | undefined {
  const due = (query.history ?? []).filter(row => row.nextReadAt <= now)
    .sort((a, b) => compareHistoryKeys(recoveryHistoryKey(a), recoveryHistoryKey(b)));
  return due.find(row => previous === null || recoveryHistoryKey(row) > previous) ?? due[0];
}
function compareHistoryKeys(left: string, right: string): number { return left === right ? 0 : left < right ? -1 : 1; }
function laneOrder(state: RecoveryScheduleState): RecoveryLane[] {
  if (state.phase === 0) return ['fx', 'targeted', 'history', 'logs', 'mode'];
  if (state.phase === 1) return ['history', 'logs', 'targeted', 'mode', 'fx'];
  if (state.phase === 2) return ['targeted', 'fx', 'history', 'logs', 'mode'];
  return state.logs_first ? ['logs', 'mode', 'targeted', 'history', 'fx'] : ['mode', 'logs', 'targeted', 'history', 'fx'];
}
function maximums(phase: number): Record<RecoveryLane, number> {
  if (phase === 0 || phase === 2) return { fx: 3, targeted: 2, history: 0, logs: 0, mode: 0 };
  if (phase === 1) return { history: 4, logs: 1, targeted: 0, mode: 0, fx: 0 };
  return { mode: 2, logs: 1, targeted: 2, history: 0, fx: 0 };
}
/** The planner assigns opportunities, not negative observations or historical coverage. */
export function planScheduledRecovery(query: ExchangeRecoveryQuery, binding: RecoveryScheduleBinding,
  state: RecoveryScheduleState, attemptId: string, now: number, busy: boolean): ScheduledRecoveryQuery {
  const history = nextHistory(query, state.history_after, now), caps = maximums(state.phase);
  const needed = { fx: true, targeted: query.orders.length > 0, mode: query.readAccountMode === true,
    logs: query.accountLogs !== undefined, history: history !== undefined };
  const deferred = state.cooldown_until > now ? 'cooldown' : busy || state.next_due_at > now ? 'not_due' : null;
  const grants = laneOrder(state).map(lane => {
    const reason: RecoveryScheduleRequest['grants'][number]['deferredReason'] = deferred ?? (caps[lane] === 0 ? 'phase_deferred' : !needed[lane] ? 'not_needed'
      : lane === 'logs' && query.accountLogs!.nextReadAt > now ? 'not_due' : null);
    return { lane, maxCalls: reason === null ? caps[lane] : 0, deferredReason: reason };
  });
  const has = (lane: RecoveryLane) => grants.some(grant => grant.lane === lane && grant.maxCalls > 0);
  return { since: query.since, orders: structuredClone(query.orders),
    ...(query.readAccountMode ? { readAccountMode: true } : {}),
    ...(has('logs') ? { accountLogs: structuredClone(query.accountLogs!) } : {}),
    history: has('history') && history ? [structuredClone(history)] : [],
    ...(has('fx') ? { fxEvidence: { version: 1, legIds: [...LEG_ROTATIONS[state.fx_rotation]!] } as FxEvidenceRequest } : {}),
    recoverySchedule: { version: 1, profile: 'bybit-usd-fx-recovery-v1', attemptId, revision: state.revision,
      phase: state.phase, binding, cooldownUntil: state.cooldown_until, grants } };
}
