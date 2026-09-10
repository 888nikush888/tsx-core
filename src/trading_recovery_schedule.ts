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
function compareHistoryKeys(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
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
function requiredAccountLogs(query: ExchangeRecoveryQuery): NonNullable<ExchangeRecoveryQuery['accountLogs']> {
  if (!query.accountLogs) throw new Error('Recovery schedule logs grant without account logs.');
  return query.accountLogs;
}

function rotationLegs(rotation: number): FxEvidenceRequest['legIds'] {
  const legs = LEG_ROTATIONS[rotation];
  if (!legs) throw new Error('Recovery schedule rotation out of range.');
  return legs;
}

function neededLanes(query: ExchangeRecoveryQuery, history: ExchangeHistoryCheckpoint | undefined): Record<RecoveryLane, boolean> {
  return { fx: true, targeted: query.orders.length > 0, mode: query.readAccountMode === true,
    logs: query.accountLogs !== undefined, history: history !== undefined };
}

function laneGrants(state: RecoveryScheduleState, caps: Record<RecoveryLane, number>,
  needed: Record<RecoveryLane, boolean>, query: ExchangeRecoveryQuery, now: number,
  deferred: 'cooldown' | 'not_due' | null): RecoveryScheduleRequest['grants'] {
  return laneOrder(state).map(lane => {
    const reason = deferred ?? laneDeferredReason(lane, caps[lane], needed[lane], query, now);
    return { lane, maxCalls: reason === null ? caps[lane] : 0, deferredReason: reason };
  });
}

function grantedLogs(query: ExchangeRecoveryQuery, hasLogs: boolean): { accountLogs?: ExchangeRecoveryQuery['accountLogs'] } {
  if (!hasLogs) return {};
  return { accountLogs: structuredClone(requiredAccountLogs(query)) };
}

function grantedFx(state: RecoveryScheduleState, hasFx: boolean): { fxEvidence?: FxEvidenceRequest } {
  if (!hasFx) return {};
  return { fxEvidence: { version: 1, legIds: [...rotationLegs(state.fx_rotation)] } as FxEvidenceRequest };
}
/** The planner assigns opportunities, not negative observations or historical coverage. */
export function planScheduledRecovery(query: ExchangeRecoveryQuery, binding: RecoveryScheduleBinding,
  state: RecoveryScheduleState, attemptId: string, now: number, busy: boolean): ScheduledRecoveryQuery {
  const history = nextHistory(query, state.history_after, now), caps = maximums(state.phase);
  const needed = neededLanes(query, history);
  const deferred = scheduleDeferredReason(state, now, busy);
  const grants = laneGrants(state, caps, needed, query, now, deferred);
  const has = (lane: RecoveryLane) => grants.some(grant => grant.lane === lane && grant.maxCalls > 0);
  return { since: query.since, orders: structuredClone(query.orders),
    ...(query.readAccountMode ? { readAccountMode: true } : {}),
    ...grantedLogs(query, has('logs')),
    history: has('history') && history ? [structuredClone(history)] : [],
    ...grantedFx(state, has('fx')),
    recoverySchedule: { version: 1, profile: 'bybit-usd-fx-recovery-v1', attemptId, revision: state.revision,
      phase: state.phase, binding, cooldownUntil: state.cooldown_until, grants } };
}

function scheduleDeferredReason(state: RecoveryScheduleState, now: number, busy: boolean): 'cooldown' | 'not_due' | null {
  if (state.cooldown_until > now) return 'cooldown';
  return busy || state.next_due_at > now ? 'not_due' : null;
}
function laneDeferredReason(lane: RecoveryLane, cap: number, needed: boolean, query: ExchangeRecoveryQuery, now: number): RecoveryScheduleRequest['grants'][number]['deferredReason'] {
  if (cap === 0) return 'phase_deferred';
  if (!needed) return 'not_needed';
  if (lane !== 'logs') return null;
  const nextReadAt = query.accountLogs?.nextReadAt;
  if (nextReadAt === undefined) return 'not_needed';
  return nextReadAt > now ? 'not_due' : null;
}
