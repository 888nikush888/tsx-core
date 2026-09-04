import { getDatabase } from './db.js';
import { assertHistoryContinuation, validateHistoryCheckpoint } from './exchange_history_contract.js';
import { getAccountBaseline } from './trading_account_baseline.js';
import type { ExchangeHistoryCheckpoint, ExchangeHistoryProgress, TradingAccount } from './trading_types.js';

/** The caller's account fingerprint was verified before acquiring remote evidence. */
export async function historyCheckpoints(account: TradingAccount, since: number): Promise<ExchangeHistoryCheckpoint[]> {
  if (!account.externalAccountId) return [];
  const database = getDatabase();
  for (const source of ['orders', 'fills'] as const) {
    const initial: ExchangeHistoryCheckpoint = { source, providerSymbol: null, revision: 0, baselineSince: since,
      windowSince: since, windowUntil: null, cursor: null, scannedThrough: null, nextReadAt: 0,
      completeness: 'unknown', reason: 'history_pending' };
    initial.coverage = null;
    initial.retention = null;
    await database.run(
      `INSERT INTO trading_history_checkpoints (account_id, account_fingerprint, source, provider_symbol, revision, checkpoint_json, updated_at)
       VALUES (?, ?, ?, '', 0, ?, ?) ON CONFLICT(account_id, account_fingerprint, source, provider_symbol) DO NOTHING`,
      [account.id, account.externalAccountId, source, JSON.stringify(initial), Date.now()],
    );
  }
  const rows = await database.all<Array<{ checkpoint_json: string }>>(
    `SELECT checkpoint_json FROM trading_history_checkpoints WHERE account_id = ? AND account_fingerprint = ?
     ORDER BY updated_at, source, provider_symbol LIMIT 8`, [account.id, account.externalAccountId],
  );
  const states: ExchangeHistoryCheckpoint[] = [];
  const baseline = await getAccountBaseline(account);
  for (const row of rows) states.push(await alignEvidenceWindow(account, validateHistoryCheckpoint(JSON.parse(row.checkpoint_json)), since, baseline?.boundary));
  return states;
}

async function alignEvidenceWindow(account: TradingAccount, previous: ExchangeHistoryCheckpoint, since: number, boundary?: number): Promise<ExchangeHistoryCheckpoint> {
  const provenAdvance = boundary !== undefined && since <= boundary && since > previous.baselineSince;
  const legacyCoverage = previous.source === 'fills' && previous.coverage === undefined;
  if (since >= previous.baselineSince && !provenAdvance && !legacyCoverage) return previous;
  // A restore/import can reveal an older obligation. Invalidate in-flight responses and re-read,
  // never pretend a cursor for a later time range also covered the earlier evidence.
  const restartSince = provenAdvance ? since : Math.min(since, previous.baselineSince);
  const reset: ExchangeHistoryCheckpoint = { ...previous, revision: previous.revision + 1, baselineSince: restartSince,
    windowSince: restartSince, windowUntil: null, cursor: null, scannedThrough: null, nextReadAt: 0, coverage: null, retention: null,
    completeness: 'unknown', reason: legacyCoverage ? 'legacy_coverage_unproved'
      : provenAdvance ? 'proven_baseline_window' : 'earlier_obligation_discovered' };
  const result = await getDatabase().run(
    `UPDATE trading_history_checkpoints SET revision = ?, checkpoint_json = ?, updated_at = ?
     WHERE account_id = ? AND account_fingerprint = ? AND source = ? AND provider_symbol = ? AND revision = ?`,
    [reset.revision, JSON.stringify(reset), Date.now(), account.id, account.externalAccountId, previous.source, previous.providerSymbol ?? '', previous.revision],
  );
  if (result.changes !== 1) throw new Error('History checkpoint changed during earlier-obligation recovery.');
  return reset;
}

/** Called inside the acquisition transaction, after every received fill/order is durable. */
export async function persistHistoryProgress(account: TradingAccount, progress: ExchangeHistoryProgress[]): Promise<void> {
  if (!progress.length) return;
  if (!account.externalAccountId) throw new Error('History checkpoint requires a verified account fingerprint.');
  for (const update of progress) await persistCheckpoint(account, update);
}

async function persistCheckpoint(account: TradingAccount, update: ExchangeHistoryProgress): Promise<void> {
  const database = getDatabase();
  const next = update.checkpoint;
  const scope = [account.id, account.externalAccountId, next.source, next.providerSymbol ?? ''];
  const previous = await database.get<{ checkpoint_json: string }>(
    'SELECT checkpoint_json FROM trading_history_checkpoints WHERE account_id = ? AND account_fingerprint = ? AND source = ? AND provider_symbol = ?', scope,
  );
  if (!previous) throw new Error('History progress has no bound local checkpoint.');
  assertHistoryContinuation(validateHistoryCheckpoint(JSON.parse(previous.checkpoint_json)), update);
  const result = await database.run(
    `UPDATE trading_history_checkpoints SET revision = ?, checkpoint_json = ?, updated_at = ?
     WHERE account_id = ? AND account_fingerprint = ? AND source = ? AND provider_symbol = ? AND revision = ?`,
    [next.revision, JSON.stringify(next), Date.now(), ...scope, update.baseRevision],
  );
  if (result.changes !== 1) throw new Error('History checkpoint changed before evidence commit.');
}
