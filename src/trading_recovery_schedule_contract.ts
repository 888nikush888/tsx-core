import { validateFxLegReceipt, type FxLegId, type FxLegReceipt } from './trading_fx_contract.js';
import { isDeepStrictEqual } from 'node:util';

export type RecoveryLane = 'targeted' | 'mode' | 'logs' | 'history' | 'fx';
export type RecoveryDeferredReason = 'phase_deferred' | 'not_due' | 'not_needed' | 'cooldown';
export type RecoveryReadReason = 'budget_exhausted' | 'transient' | 'unsupported' | 'invalid_evidence';
export interface RecoveryScheduleBinding {
  accountId: string; accountFingerprint: string; credentialGeneration: string;
  mode: 'live' | 'testnet'; executionProfileHash: string;
}
export interface RecoveryScheduleRequest {
  version: 1; profile: 'bybit-usd-fx-recovery-v1'; attemptId: string; revision: number; phase: 0 | 1 | 2 | 3;
  binding: RecoveryScheduleBinding; cooldownUntil: number;
  grants: Array<{ lane: RecoveryLane; maxCalls: number; deferredReason: RecoveryDeferredReason | null }>;
}
export interface FxEvidenceRequest { version: 1; legIds: FxLegId[] }
export interface FxEvidenceProgress {
  version: 1; calls: number; receipts: FxLegReceipt[]; reason: RecoveryReadReason | null; nextReadAt: number;
}
export interface RecoveryScheduleProgress {
  version: 1; profile: 'bybit-usd-fx-recovery-v1'; attemptId: string; baseRevision: number; phase: 0 | 1 | 2 | 3;
  binding: RecoveryScheduleBinding; calls: number; cooldownUntil: number;
  lanes: Array<{ lane: RecoveryLane; calls: number; reason: RecoveryDeferredReason | RecoveryReadReason | null }>;
}
/** Existing source-specific request/response validators remain mandatory. */
export interface RecoveryScheduleInputs {
  recoverySchedule?: unknown; fxEvidence?: unknown; readAccountMode?: boolean; accountLogs?: unknown; history?: unknown;
}
export interface RecoveryScheduleAcquisition {
  startedAt: number; completedAt: number; targetedCalls?: unknown; checkedOrders?: unknown;
  accountMode?: unknown; accountLogs?: unknown; history?: unknown; fxEvidence?: unknown;
}
type ReadWindow = { startedAt: number; completedAt: number };
type LaneEvidence = { calls: number; reasons: unknown[]; cooldown: number };
const PROFILE = 'bybit-usd-fx-recovery-v1';
const CAPS: Record<RecoveryLane, number[]> = { targeted: [0, 2], mode: [0, 2], logs: [0, 1], history: [0, 4], fx: [0, 1, 2, 3] };
const PHASE_LANES: RecoveryLane[][] = [['fx', 'targeted'], ['history', 'logs'], ['fx', 'targeted'], ['mode', 'logs', 'targeted']];
const DEFERRED = ['phase_deferred', 'not_due', 'not_needed', 'cooldown'];
const FAILURES = ['budget_exhausted', 'transient', 'unsupported', 'invalid_evidence'];
const LEGS = ['bybit:btc-usd-index:v1', 'bybit:btc-usdt-index:v1', 'bybit:usdc-usd-index:v1'];
const BINDING_KEYS = 'accountId accountFingerprint credentialGeneration mode executionProfileHash';

function invalid(): never { throw new Error('RECOVERY_SCHEDULE_INVALID'); }
function object(value: unknown, keys?: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const own = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (own.some(key => typeof key !== 'string' || !descriptors[key].enumerable || !('value' in descriptors[key]))) invalid();
  if (keys && own.map(String).sort().join(' ') !== keys.split(' ').sort().join(' ')) invalid();
  return value as Record<string, any>;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) invalid();
  return Number(value);
}
function array(value: unknown, maximum: number): any[] {
  if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) invalid();
  return value;
}
function binding(value: unknown, expected: RecoveryScheduleBinding): void {
  const row = object(value, BINDING_KEYS), context = object(expected, BINDING_KEYS);
  if (typeof row.accountId !== 'string' || [...row.accountId].length > 256 || !row.accountId
    || row.accountId.trim() !== row.accountId || /[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(row.accountId)) invalid();
  for (const field of ['accountFingerprint', 'credentialGeneration', 'executionProfileHash']) {
    if (typeof row[field] !== 'string' || !/^[a-f0-9]{64}$/.test(row[field])) invalid();
  }
  if (!['live', 'testnet'].includes(row.mode) || BINDING_KEYS.split(' ').some(key => row[key] !== context[key])) invalid();
}
function header(row: Record<string, any>, expected: RecoveryScheduleBinding): void {
  if (row.version !== 1 || row.profile !== PROFILE || typeof row.attemptId !== 'string'
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.attemptId)) invalid();
  integer(row.phase, 3); integer(row.cooldownUntil); binding(row.binding, expected);
  if (Buffer.byteLength(JSON.stringify(row)) >= 8192) invalid();
}
function grants(value: unknown, phase: number): RecoveryScheduleRequest['grants'] {
  const rows = array(value, 5), seen = new Set<string>();
  if (rows.length !== 5) invalid();
  let total = 0;
  for (const item of rows) {
    const row = object(item, 'lane maxCalls deferredReason');
    if (typeof row.lane !== 'string' || !Object.hasOwn(CAPS, row.lane) || seen.has(row.lane)) invalid();
    const lane = row.lane as RecoveryLane, calls = integer(row.maxCalls, 5);
    if (!CAPS[lane].includes(calls) || (calls > 0 && !PHASE_LANES[phase].includes(lane))) invalid();
    if (calls > 0 ? row.deferredReason !== null : !DEFERRED.includes(row.deferredReason)) invalid();
    seen.add(lane); total += calls;
  }
  if (total > 5) invalid();
  return rows as RecoveryScheduleRequest['grants'];
}
export function validateRecoveryScheduleRequest(value: unknown, expected: RecoveryScheduleBinding): RecoveryScheduleRequest {
  const row = object(value, 'version profile attemptId revision phase binding cooldownUntil grants');
  integer(row.revision); integer(row.phase, 3); grants(row.grants, row.phase); header(row, expected);
  return structuredClone(row) as RecoveryScheduleRequest;
}
function fxRequest(value: unknown, maximum: number): FxEvidenceRequest {
  const row = object(value, 'version legIds'), legs = array(row.legIds, 3);
  if (row.version !== 1 || legs.length !== maximum || legs.length === 0 || new Set(legs).size !== legs.length
    || legs.some(leg => !LEGS.includes(leg))) invalid();
  return structuredClone(row) as FxEvidenceRequest;
}
function laneGrant(request: RecoveryScheduleRequest, lane: RecoveryLane): number {
  return request.grants.find(row => row.lane === lane)!.maxCalls;
}
function requestedSourcePresence(recovery: Record<string, any>, request: RecoveryScheduleRequest, expected: RecoveryScheduleBinding): void {
  if (recovery.readAccountMode !== undefined && typeof recovery.readAccountMode !== 'boolean') invalid();
  if (laneGrant(request, 'mode') > 0 && recovery.readAccountMode !== true) invalid();
  if ((laneGrant(request, 'logs') > 0) !== (recovery.accountLogs !== undefined)) invalid();
  if (recovery.accountLogs !== undefined) {
    const checkpoint = object(recovery.accountLogs);
    if (checkpoint.accountFingerprint !== expected.accountFingerprint || checkpoint.credentialGeneration !== expected.credentialGeneration) invalid();
  }
  const history = array(recovery.history === undefined ? [] : recovery.history, 1);
  if (history.length !== (laneGrant(request, 'history') > 0 ? 1 : 0)) invalid();
  if (history.length) object(history[0]);
}
export function validateRecoveryScheduleInputs(value: RecoveryScheduleInputs, expected: RecoveryScheduleBinding):
  { recoverySchedule: RecoveryScheduleRequest; fxEvidence?: FxEvidenceRequest } | undefined {
  const recovery = object(value);
  if (recovery.recoverySchedule === undefined) {
    if (recovery.fxEvidence !== undefined) invalid();
    return undefined;
  }
  const request = validateRecoveryScheduleRequest(recovery.recoverySchedule, expected);
  requestedSourcePresence(recovery, request, expected);
  const maximum = laneGrant(request, 'fx');
  if ((maximum > 0) !== (recovery.fxEvidence !== undefined)) invalid();
  return { recoverySchedule: request, ...(maximum ? { fxEvidence: fxRequest(recovery.fxEvidence, maximum) } : {}) };
}
function readWindow(value: ReadWindow): void {
  integer(value.startedAt); integer(value.completedAt);
  if (value.completedAt < value.startedAt || value.completedAt - value.startedAt > 35000 || value.completedAt > Date.now() + 1000) invalid();
}
function fxProgressShape(value: unknown): Record<string, any> {
  const row = object(value, 'version calls receipts reason nextReadAt');
  const receipts = array(row.receipts, 3), calls = integer(row.calls, 3);
  integer(row.nextReadAt);
  if (row.version !== 1 || ![null, ...FAILURES].includes(row.reason) || receipts.length > calls || calls > receipts.length + 1) invalid();
  if (row.reason === null && (calls !== receipts.length || calls === 0)) invalid();
  return row;
}
export function validateFxEvidenceProgress(value: unknown, requested: FxEvidenceRequest,
  expected: RecoveryScheduleBinding, read: ReadWindow): FxEvidenceProgress {
  binding(expected, expected); readWindow(read);
  const request = fxRequest(requested, array(object(requested).legIds, 3).length);
  const row = fxProgressShape(value);
  const receipts = row.receipts, calls = integer(row.calls, request.legIds.length);
  if (row.reason === null ? receipts.length !== request.legIds.length || calls !== receipts.length : receipts.length === request.legIds.length) invalid();
  for (let index = 0; index < receipts.length; index++) {
    const receipt = validateFxLegReceipt(receipts[index], { mode: expected.mode, profileHash: expected.executionProfileHash });
    if (receipt.legId !== request.legIds[index] || receipt.startedAt < read.startedAt || receipt.completedAt > read.completedAt) invalid();
  }
  return structuredClone(row) as FxEvidenceProgress;
}
function modeObservation(value: unknown, acquisition: RecoveryScheduleAcquisition, expected: RecoveryScheduleBinding): void {
  const proof = object(value);
  readWindow(proof as ReadWindow);
  if (proof.accountFingerprint !== expected.accountFingerprint || proof.credentialGeneration !== expected.credentialGeneration
    || proof.startedAt < acquisition.startedAt || proof.completedAt > acquisition.completedAt) invalid();
}
function modeEvidence(recovery: RecoveryScheduleInputs, acquisition: RecoveryScheduleAcquisition,
  request: RecoveryScheduleRequest, expected: RecoveryScheduleBinding): LaneEvidence {
  if (recovery.readAccountMode !== true) {
    if (acquisition.accountMode !== undefined) invalid();
    return { calls: 0, reasons: [], cooldown: 0 };
  }
  const row = object(acquisition.accountMode), calls = integer(row.calls, 2);
  if (![null, 'budget_exhausted', 'transient', 'unsupported'].includes(row.reason)) invalid();
  if (row.observation === null ? row.reason === null : calls !== 2 || row.reason !== null) invalid();
  if (laneGrant(request, 'mode') === 0 && (calls !== 0 || row.observation !== null || row.reason !== 'budget_exhausted')) invalid();
  if (row.observation !== null) modeObservation(row.observation, acquisition, expected);
  return { calls, reasons: [row.reason], cooldown: 0 };
}
function checkpointCollection(acquisition: RecoveryScheduleAcquisition, historical: boolean): unknown[] {
  if (historical) return array(acquisition.history === undefined ? [] : acquisition.history, 1);
  return acquisition.accountLogs === undefined ? [] : [acquisition.accountLogs];
}
function checkpointBinding(previous: Record<string, any>, next: Record<string, any>, historical: boolean,
  expected: RecoveryScheduleBinding): void {
  const fields = historical ? ['source', 'providerSymbol', 'baselineSince'] : ['namespace', 'filterHash', 'accountFingerprint', 'credentialGeneration'];
  if (fields.some(field => previous[field] !== next[field])) invalid();
  if (!historical && (next.accountFingerprint !== expected.accountFingerprint || next.credentialGeneration !== expected.credentialGeneration)) invalid();
}
function skippedLogEvidence(progress: Record<string, any>, previous: Record<string, any>): LaneEvidence {
  if (!FAILURES.includes(progress.readSkipped) || progress.calls !== 0 || array(progress.receipts, 0).length !== 0
    || progress.baseRevision !== previous.revision || !isDeepStrictEqual(progress.checkpoint, previous)) invalid();
  return { calls: 0, reasons: [progress.readSkipped], cooldown: 0 };
}
function checkpointEvidence(recovery: RecoveryScheduleInputs, acquisition: RecoveryScheduleAcquisition, lane: 'logs' | 'history',
  request: RecoveryScheduleRequest, expected: RecoveryScheduleBinding): LaneEvidence {
  const historical = lane === 'history';
  const results = checkpointCollection(acquisition, historical);
  if (results.length !== (laneGrant(request, lane) > 0 ? 1 : 0)) invalid();
  if (!results.length) return { calls: 0, reasons: [], cooldown: 0 };
  const previous = object(historical ? (recovery.history as unknown[])[0] : recovery.accountLogs);
  const progress = object(results[0]), next = object(progress.checkpoint), calls = integer(historical ? progress.pages : progress.calls, 5);
  if (!historical && calls === 0) return skippedLogEvidence(progress, previous);
  if (progress.readSkipped !== undefined) invalid();
  if (integer(progress.baseRevision) !== integer(previous.revision) || integer(next.revision) !== progress.baseRevision + 1) invalid();
  checkpointBinding(previous, next, historical, expected);
  const cooldown = ['transient', 'history_transient'].includes(next.reason) ? integer(next.nextReadAt) : 0;
  return { calls, reasons: [next.reason], cooldown };
}
function progressShape(value: unknown): Record<string, any> {
  const row = object(value, 'version profile attemptId baseRevision phase binding calls cooldownUntil lanes');
  const lanes = array(row.lanes, 5), seen = new Set<string>();
  integer(row.baseRevision); integer(row.phase, 3); integer(row.calls, 5);
  let total = 0;
  for (const value of lanes) {
    const lane = object(value, 'lane calls reason');
    if (typeof lane.lane !== 'string' || !Object.hasOwn(CAPS, lane.lane) || seen.has(lane.lane)) invalid();
    const name = lane.lane as RecoveryLane, calls = integer(lane.calls, Math.max(...CAPS[name]));
    if (![null, ...DEFERRED, ...FAILURES].includes(lane.reason)
      || (calls > 0 && (DEFERRED.includes(lane.reason) || !PHASE_LANES[row.phase].includes(name)))) invalid();
    seen.add(name); total += calls;
  }
  if (lanes.length !== 5 || total !== row.calls || total > 5) invalid();
  // Self-consistency only. This parser has no authority to select an account/profile.
  header(row, row.binding);
  return row;
}
/** Structural decoding only; NEVER replaces request/current-account authorization before persistence. */
export function parseRecoveryScheduleAcquisitionFields(result: { recoverySchedule?: unknown; fxEvidence?: unknown }):
  { recoverySchedule?: RecoveryScheduleProgress; fxEvidence?: FxEvidenceProgress } {
  if (result.recoverySchedule === undefined) {
    if (result.fxEvidence !== undefined) invalid();
    return {};
  }
  const recoverySchedule = progressShape(result.recoverySchedule);
  if (result.fxEvidence === undefined) return { recoverySchedule: structuredClone(recoverySchedule) as RecoveryScheduleProgress };
  const fx = fxProgressShape(result.fxEvidence);
  for (const value of fx.receipts) {
    const receipt = object(value);
    validateFxLegReceipt(receipt, { mode: receipt.mode, profileHash: receipt.profileHash });
  }
  return { recoverySchedule: structuredClone(recoverySchedule) as RecoveryScheduleProgress, fxEvidence: structuredClone(fx) as FxEvidenceProgress };
}
function acquisitionEvidence(recovery: RecoveryScheduleInputs, acquisition: RecoveryScheduleAcquisition,
  request: RecoveryScheduleRequest, fx: FxEvidenceRequest | undefined, expected: RecoveryScheduleBinding): Record<RecoveryLane, LaneEvidence> {
  readWindow(acquisition);
  const checked = array(acquisition.checkedOrders ?? [], 250);
  const result = { targeted: { calls: integer(acquisition.targetedCalls, 5), reasons: checked.map(row => object(row).status), cooldown: 0 },
    mode: modeEvidence(recovery, acquisition, request, expected),
    logs: checkpointEvidence(recovery, acquisition, 'logs', request, expected),
    history: checkpointEvidence(recovery, acquisition, 'history', request, expected), fx: { calls: 0, reasons: [], cooldown: 0 } };
  if ((fx !== undefined) !== (acquisition.fxEvidence !== undefined)) invalid();
  if (fx) {
    const progress = validateFxEvidenceProgress(acquisition.fxEvidence, fx, expected, acquisition);
    result.fx = { calls: progress.calls, reasons: [progress.reason], cooldown: progress.nextReadAt };
  }
  return result;
}
function sourceReason(reasons: unknown[]): string | null {
  const aliases: Record<string, string> = { history_transient: 'transient', source_unsupported: 'unsupported',
    history_profile_unsupported: 'unsupported', invalid_source_evidence: 'invalid_evidence', history_budget_exhausted: 'budget_exhausted' };
  const normalized = reasons.map(reason => typeof reason === 'string' && Object.hasOwn(aliases, reason) ? aliases[reason] : reason);
  return ['transient', 'invalid_evidence', 'unsupported', 'budget_exhausted'].find(reason => normalized.includes(reason)) ?? null;
}
function responseLanes(row: Record<string, any>, request: RecoveryScheduleRequest,
  evidence: Record<RecoveryLane, LaneEvidence>, read: ReadWindow): void {
  const rows = array(row.lanes, 5);
  if (rows.length !== request.grants.length) invalid();
  let total = 0;
  for (let index = 0; index < rows.length; index++) {
    const lane = object(rows[index], 'lane calls reason'), grant = request.grants[index], proof = evidence[grant.lane];
    const calls = integer(lane.calls, grant.maxCalls);
    if (lane.lane !== grant.lane || calls !== proof.calls) invalid();
    const reason = sourceReason(proof.reasons);
    if (grant.maxCalls === 0) { if (lane.reason !== grant.deferredReason) invalid(); }
    else if (lane.reason === 'cooldown') {
      if (calls !== 0 || row.cooldownUntil <= read.startedAt || reason === 'transient') invalid();
    } else if (lane.reason !== reason) invalid();
    if (row.cooldownUntil < proof.cooldown) invalid();
    total += calls;
  }
  if (total !== row.calls || total > 5) invalid();
}
/** Validates this attempt only; no durable scheduling, source finality or valuation is inferred. */
export function validateRecoveryScheduleProgress(value: unknown, recovery: RecoveryScheduleInputs,
  acquisition: RecoveryScheduleAcquisition, expected: RecoveryScheduleBinding): RecoveryScheduleProgress | undefined {
  const inputs = validateRecoveryScheduleInputs(recovery, expected);
  if (!inputs) {
    if (value !== undefined || acquisition.fxEvidence !== undefined) invalid();
    return undefined;
  }
  const request = inputs.recoverySchedule;
  const row = progressShape(value);
  binding(row.binding, expected);
  if (row.attemptId !== request.attemptId || row.baseRevision !== request.revision || row.phase !== request.phase
    || row.cooldownUntil < request.cooldownUntil) invalid();
  if (request.cooldownUntil > acquisition.completedAt && row.calls !== 0) invalid();
  if (row.cooldownUntil > Math.max(request.cooldownUntil, acquisition.completedAt + 86_400_000)) invalid();
  const evidence = acquisitionEvidence(recovery, acquisition, request, inputs.fxEvidence, expected);
  responseLanes(row, request, evidence, acquisition);
  return structuredClone(row) as RecoveryScheduleProgress;
}
