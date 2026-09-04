import type { ExchangeAcquisitionEvidence, ExchangeHistoryCheckpoint, ExchangeHistoryCoverage, ExchangeHistoryProgress } from './trading_types.js';

const PROFILES: Readonly<Record<string, string>> = {
  bybit: 'bybit_v5_linear_endpoint_v1', krakenfutures: 'kraken_v3_executions_v1', hyperliquid: 'hyperliquid_retained_fills_v1',
};

export function validateHistoryCoverage(value: unknown, state: ExchangeHistoryCheckpoint): ExchangeHistoryCoverage | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid historical coverage object.');
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || !Object.values(PROFILES).includes(String(row.profile)) || state.source !== 'fills'
    || !Number.isSafeInteger(row.since) || !Number.isSafeInteger(row.through) || row.since !== state.baselineSince
    || state.scannedThrough === null || Number(row.through) < Number(row.since) || Number(row.through) > state.scannedThrough) {
    throw new Error('Invalid historical coverage interval or profile.');
  }
  return { version: 1, profile: String(row.profile), since: Number(row.since), through: Number(row.through) };
}

export function assertCoverageContinuation(previous: ExchangeHistoryCheckpoint, update: ExchangeHistoryProgress): void {
  const old = previous.coverage;
  const next = update.checkpoint.coverage;
  if (old && (!next || next.profile !== old.profile || next.since !== old.since || next.through < old.through)) {
    throw new Error('Historical coverage cannot disappear, change profile or regress.');
  }
  if (!next || (old && next.through === old.through)) return;
  assertRetentionCoverageBound(update.checkpoint);
  if (update.pages === 0 || previous.windowSince > (old?.through ?? previous.baselineSince)
    || next.through > previous.windowSince + update.pages * 7 * 86_400_000) {
    throw new Error('Historical coverage cannot bridge an unread window.');
  }
}

function assertRetentionCoverageBound(state: ExchangeHistoryCheckpoint): void {
  const retention = state.retention;
  if (!retention) return;
  if (retention.phase !== 'proved' || retention.fixedUntil === null
    || state.coverage!.profile !== PROFILES.hyperliquid || state.coverage!.through > Math.min(retention.originalUntil, retention.fixedUntil)) {
    throw new Error('Historical coverage exceeds verified retention.');
  }
}

function checkpointProofReason(exchange: string, checkpoint: ExchangeHistoryCheckpoint): string | null {
  if (exchange === 'krakenfutures' && !checkpoint.providerAccountUid) return 'FILL_PROVIDER_IDENTITY_UNPROVED';
  const coverage = checkpoint.coverage;
  if (!coverage || coverage.profile !== PROFILES[exchange] || checkpoint.completeness !== 'complete' || checkpoint.cursor !== null) return 'FILL_COVERAGE_UNPROVED';
  if (checkpoint.retention && (exchange !== 'hyperliquid' || checkpoint.retention.phase !== 'proved')) return 'FILL_COVERAGE_UNPROVED';
  return null;
}

/** Only a fresh, account-wide, requested and durably ingested range can certify fills. */
export function fillCoverageReason(exchange: string, evidence: ExchangeAcquisitionEvidence, since: number): string | null {
  if (exchange === 'bybit') return 'FILL_OPTION_SCOPE_UNPROVED';
  const profile = PROFILES[exchange];
  const rows = evidence.history?.filter(row => row.checkpoint.source === 'fills' && row.checkpoint.providerSymbol === null) ?? [];
  if (!profile || rows.length !== 1) return 'FILL_COVERAGE_MISSING';
  const { checkpoint, pages } = rows[0]!;
  const reason = checkpointProofReason(exchange, checkpoint);
  if (reason) return reason;
  const coverage = checkpoint.coverage!;
  if (coverage.since > since || coverage.since !== checkpoint.baselineSince) return 'FILL_BASELINE_UNPROVED';
  if (pages === 0 || coverage.through < evidence.startedAt || coverage.through > evidence.completedAt) return 'FILL_COVERAGE_NOT_FRESH';
  if (!retentionIsFresh(checkpoint, evidence)) return 'FILL_COVERAGE_NOT_FRESH';
  return null;
}

function retentionIsFresh(checkpoint: ExchangeHistoryCheckpoint, evidence: ExchangeAcquisitionEvidence): boolean {
  const retention = checkpoint.retention;
  if (!retention) return true;
  return retention.fixedUntil !== null && checkpoint.coverage!.through <= Math.min(retention.fixedUntil, retention.originalUntil)
    && retention.validatedAt !== null && retention.validatedAt >= evidence.startedAt && retention.validatedAt <= evidence.completedAt;
}

export function assertCompleteFillCoverage(exchange: string, evidence: ExchangeAcquisitionEvidence, since: number): void {
  if (!evidence.sources.some(source => source.source === 'fills' && source.completeness === 'complete')) return;
  const reason = fillCoverageReason(exchange, evidence, since);
  if (reason) throw new Error(`Invalid complete fill source: ${reason}`);
}
