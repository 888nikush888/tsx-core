import type { ExchangeHistoryCheckpoint, ExchangeHistoryProgress, ExchangeHistoryRetention } from './trading_types.js';
import { assertCoverageContinuation, validateHistoryCoverage } from './exchange_history_coverage.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid history checkpoint object.');
  return value as Record<string, unknown>;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Invalid history checkpoint number.');
  return Number(value);
}

function token(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value || value.length > maximum || /[\x00-\x1f]/.test(value)) throw new Error('Invalid history checkpoint token.');
  return value;
}

export function validateHistoryCheckpoint(value: unknown): ExchangeHistoryCheckpoint {
  const row = object(value);
  if (!['orders', 'fills'].includes(String(row.source)) || !['unknown', 'partial', 'complete'].includes(String(row.completeness))) {
    throw new Error('Invalid history checkpoint scope or completeness.');
  }
  const result = {
    source: row.source as ExchangeHistoryCheckpoint['source'], providerSymbol: token(row.providerSymbol, 256),
    revision: integer(row.revision), baselineSince: integer(row.baselineSince), windowSince: integer(row.windowSince),
    windowUntil: row.windowUntil === null ? null : integer(row.windowUntil), cursor: token(row.cursor, 4096),
    scannedThrough: row.scannedThrough === null ? null : integer(row.scannedThrough), nextReadAt: integer(row.nextReadAt),
    completeness: row.completeness as ExchangeHistoryCheckpoint['completeness'], reason: token(row.reason, 80),
  };
  validateWindow(result);
  const validated = { ...result, ...(row.providerAccountUid === undefined ? {} : { providerAccountUid: token(row.providerAccountUid, 256) }),
    ...(row.coverage === undefined ? {} : { coverage: validateHistoryCoverage(row.coverage, result) }),
    ...(row.retention === undefined ? {} : { retention: validateRetention(row.retention, result) }) };
  if (Buffer.byteLength(JSON.stringify(validated), 'utf8') >= 8192) throw new Error('Oversized history checkpoint.');
  return validated;
}

const RETENTION_FIELDS = ['version', 'phase', 'originalSince', 'originalUntil', 'startedAt', 'fixedUntil', 'cursor', 'count', 'anchor', 'validatedAt'];
const RETENTION_PHASES = ['witness', 'horizon', 'scan', 'verify', 'proved'];

function validateRetention(value: unknown, state: ExchangeHistoryCheckpoint): ExchangeHistoryRetention | null {
  if (value === null) return null;
  const row = object(value);
  if (Object.keys(row).length !== RETENTION_FIELDS.length || RETENTION_FIELDS.some(field => !(field in row))
    || row.version !== 1 || !RETENTION_PHASES.includes(String(row.phase)) || state.source !== 'fills' || state.providerSymbol !== null) {
    throw new Error('Invalid Hyperliquid retention checkpoint.');
  }
  const result: ExchangeHistoryRetention = { version: 1, phase: row.phase as ExchangeHistoryRetention['phase'],
    originalSince: integer(row.originalSince), originalUntil: integer(row.originalUntil), startedAt: integer(row.startedAt),
    cursor: integer(row.cursor), count: integer(row.count), fixedUntil: row.fixedUntil === null ? null : integer(row.fixedUntil),
    validatedAt: row.validatedAt === null ? null : integer(row.validatedAt), anchor: retentionAnchor(row.anchor) };
  validateRetentionWindow(result, state);
  validateRetentionPhase(result);
  return result;
}

function retentionAnchor(value: unknown): ExchangeHistoryRetention['anchor'] {
  if (value === null) return null;
  const row = object(value);
  if (Object.keys(row).length !== 4 || !['coin', 'tid', 'time', 'payloadHash'].every(field => field in row)
    || typeof row.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.payloadHash)
    || row.coin === null || row.tid === null) throw new Error('Invalid Hyperliquid retention anchor.');
  return { coin: token(row.coin, 256)!, tid: token(row.tid, 256)!, time: integer(row.time), payloadHash: row.payloadHash };
}

function validateRetentionWindow(probe: ExchangeHistoryRetention, state: ExchangeHistoryCheckpoint): void {
  if (probe.originalSince < state.baselineSince || probe.originalUntil < probe.originalSince
    || probe.startedAt < probe.originalUntil || probe.startedAt > Date.now() + 60_000) throw new Error('Invalid Hyperliquid retention original window.');
  if (probe.phase === 'proved') {
    if (probe.fixedUntil === null || state.scannedThrough === null || state.scannedThrough < Math.min(probe.originalUntil, probe.fixedUntil)) {
      throw new Error('Hyperliquid retention proof lacks traversal.');
    }
  } else if (state.windowSince !== probe.originalSince || state.windowUntil !== probe.originalUntil) {
    throw new Error('Hyperliquid retention changed its original window.');
  }
}

function validateRetentionPhase(probe: ExchangeHistoryRetention): void {
  if (probe.phase === 'witness') {
    if (probe.anchor !== null || probe.fixedUntil !== null || probe.count !== 0 || probe.cursor !== 0) throw new Error('Invalid initial retention phase.');
  } else if (!probe.anchor || probe.count < 1 || probe.count >= 10000 || probe.cursor < probe.anchor.time) throw new Error('Invalid counted retention anchor.');
  if (probe.phase === 'horizon' && probe.fixedUntil !== null) throw new Error('Invalid unread retention horizon.');
  validateRetentionHorizon(probe);
  validateRetentionTime(probe);
}

function validateRetentionHorizon(probe: ExchangeHistoryRetention): void {
  if (['scan', 'verify', 'proved'].includes(probe.phase) && (probe.fixedUntil === null || probe.fixedUntil < probe.startedAt
    || probe.fixedUntil > Date.now() + 60_000 || probe.cursor > probe.fixedUntil + 1)) throw new Error('Invalid fixed retention horizon.');
}

function validateRetentionTime(probe: ExchangeHistoryRetention): void {
  if (probe.phase === 'proved') {
    if (probe.validatedAt === null || probe.validatedAt < probe.startedAt || probe.validatedAt > Date.now() + 60_000) throw new Error('Invalid retention validation time.');
  } else if (probe.validatedAt !== null) throw new Error('Unverified retention has a validation time.');
}

function validateWindow(row: ExchangeHistoryCheckpoint): void {
  const latest = Date.now() + 60_000;
  if (row.baselineSince > row.windowSince || row.windowSince > latest
    || (row.windowUntil !== null && (row.windowUntil < row.windowSince || row.windowUntil > latest))
    || (row.scannedThrough !== null && (row.scannedThrough < row.baselineSince || row.scannedThrough > latest))
    || (row.cursor !== null && row.windowUntil === null)
    || (row.reason !== null && !/^[a-z_]{1,80}$/.test(row.reason))) throw new Error('Invalid history checkpoint window or reason.');
}

export function validateHistoryProgress(value: unknown): ExchangeHistoryProgress[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error('Invalid bounded history progress.');
  const rows = value.map(item => {
    const row = object(item);
    const result = { baseRevision: integer(row.baseRevision), pages: integer(row.pages), checkpoint: validateHistoryCheckpoint(row.checkpoint) };
    if (result.checkpoint.revision !== result.baseRevision + 1) throw new Error('Invalid history checkpoint revision.');
    return result;
  });
  if (rows.reduce((sum, row) => sum + row.pages, 0) > 5
    || new Set(rows.map(row => historyScope(row.checkpoint))).size !== rows.length) throw new Error('Invalid history page budget or duplicate scope.');
  if (new Set(rows.map(row => row.checkpoint.providerAccountUid).filter(Boolean)).size > 1) throw new Error('History sources disagree about provider account identity.');
  return rows;
}

export function historyScope(row: Pick<ExchangeHistoryCheckpoint, 'source' | 'providerSymbol'>): string {
  return JSON.stringify([row.source, row.providerSymbol]);
}

export function assertHistoryContinuation(previous: ExchangeHistoryCheckpoint, progress: ExchangeHistoryProgress): void {
  const next = progress.checkpoint;
  if (historyScope(previous) !== historyScope(next) || progress.baseRevision !== previous.revision
    || next.baselineSince !== previous.baselineSince || (next.scannedThrough ?? 0) < (previous.scannedThrough ?? 0)) {
    throw new Error('History continuation contradicts its requested checkpoint.');
  }
  if (previous.providerAccountUid && previous.providerAccountUid !== next.providerAccountUid) throw new Error('History provider account identity changed.');
  assertCoverageContinuation(previous, progress);
  assertRetentionContinuation(previous, progress);
  if (progress.pages === 0 && ['windowSince', 'windowUntil', 'cursor', 'scannedThrough', 'providerAccountUid'].some(
    field => previous[field as keyof ExchangeHistoryCheckpoint] !== next[field as keyof ExchangeHistoryCheckpoint],
  )) throw new Error('History progress cannot skip an unread page.');
}

function assertRetentionContinuation(previous: ExchangeHistoryCheckpoint, progress: ExchangeHistoryProgress): void {
  const old = previous.retention ?? null;
  const next = progress.checkpoint.retention ?? null;
  if (progress.pages === 0 && !isDeepStrictEqual(old, next)) throw new Error('History retention cannot skip an unread page.');
  if (!old || !next || old.phase === 'proved') return;
  if (RETENTION_PHASES.indexOf(next.phase) - RETENTION_PHASES.indexOf(old.phase) > progress.pages) {
    throw new Error('History retention cannot skip an unread phase.');
  }
  assertBoundRetentionContinuation(old, next);
}

function assertBoundRetentionContinuation(old: ExchangeHistoryRetention, next: ExchangeHistoryRetention): void {
  const identityChanged = (['originalSince', 'originalUntil', 'startedAt'] as const).some(field => old[field] !== next[field]);
  if (identityChanged
    || (old.anchor && !isDeepStrictEqual(old.anchor, next.anchor))
    || (old.fixedUntil !== null && old.fixedUntil !== next.fixedUntil)
    || next.count < old.count || next.cursor < old.cursor
    || RETENTION_PHASES.indexOf(next.phase) < RETENTION_PHASES.indexOf(old.phase)) throw new Error('History retention continuation changed its bound probe.');
}

export function assertHistoryResponse(request: ExchangeHistoryCheckpoint[], progress: ExchangeHistoryProgress[] | undefined): void {
  if (!progress || progress.length !== request.length) throw new Error('Exchange omitted requested history progress.');
  const requested = new Map(request.map(row => [historyScope(row), row]));
  for (const row of progress) {
    const previous = requested.get(historyScope(row.checkpoint));
    if (!previous) throw new Error('Exchange returned unrequested history scope.');
    assertHistoryContinuation(previous, row);
  }
}
import { isDeepStrictEqual } from 'node:util';
