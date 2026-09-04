import { createHash, randomUUID } from 'node:crypto';
import { getDatabase, withDatabaseTransaction } from './db.js';
import { validateAcquisitionEvidence } from './exchange_contract_validation.js';
import { compareDecimal } from './trading_decimal.js';
import { proveOwnedQuantity, type OwnershipOrder, type OwnershipFill } from './trading_ownership.js';
import { classifyPreBaselineHistory } from './trading_baseline_classification.js';
import { bindPostUta2Baseline, consistentModeHistory, latestAccountMode, modeBeforeBaseline, sameUta2Mode } from './trading_account_mode.js';
import { validateAccountModeObservation, type BybitAccountModeObservation } from './trading_account_mode_contract.js';
import type { ExchangeAcquisitionEvidence, ExchangeOpenState, TradingAccount, TradingSide } from './trading_types.js';

interface BaselineRow {
  id: string; status: 'candidate' | 'established'; boundary_at: number; first_completed_at: number; last_observed_at: number;
  credential_generation: string; first_evidence_json: string; proof_json: string | null;
}
interface ClosedOrder extends OwnershipOrder { intent_id: string; intent_side: TradingSide; status: string; provider_symbol: string | null; exchange_order_id: string | null }
interface LocalLedgerProof { hash: string; orderCount: number; fillCount: number }
const terminal = (status: string) => ['filled', 'cancelled', 'rejected'].includes(status);
const FRESHNESS = 30_000;

export async function getAccountBaseline(account: TradingAccount): Promise<{ id: string; boundary: number } | null> {
  if (!account.externalAccountId) return null;
  const row = await baselineRow(account);
  return row?.status === 'established' ? { id: row.id, boundary: row.boundary_at } : null;
}

/** Restored older local obligations always extend the required evidence window backwards. */
export async function requiredAccountEvidenceSince(account: TradingAccount): Promise<number> {
  const baseline = await getAccountBaseline(account);
  const earliest = await getDatabase().get<{ since: number | null }>(
    'SELECT MIN(created_at) AS since FROM trading_orders WHERE account_id = ?', [account.id]);
  const boundary = baseline?.boundary ?? account.createdAt;
  return Math.max(0, Math.min(boundary, earliest?.since ?? boundary));
}

function verifiedRemoteIdentity(account: TradingAccount, remote: ExchangeOpenState): boolean {
  return account.exchange !== 'paper' && Boolean(account.externalAccountId) && Boolean(account.credentialGeneration)
    && account.status === 'ready' && account.lastVerifiedAt !== null
    && (remote as ExchangeOpenState & { accountFingerprint?: string }).accountFingerprint === account.externalAccountId;
}

function currentFlatEvidence(account: TradingAccount, remote: ExchangeOpenState): ExchangeAcquisitionEvidence | null {
  if (!verifiedRemoteIdentity(account, remote) || remote.positions.length > 0 || remote.orders.some(order => !terminal(order.status))) return null;
  let acquisition;
  try { acquisition = validateAcquisitionEvidence(remote.acquisition); } catch { return null; }
  if (Date.now() - acquisition.startedAt > FRESHNESS || acquisition.completedAt > Date.now()) return null;
  for (const source of acquisition.sources.filter(row => ['positions', 'orders'].includes(row.source))) {
    if (source.completeness !== 'complete' || !source.scopes?.length || source.scopes.some(scope => !scope.complete)) return null;
  }
  return acquisition;
}

function terminalQuantityProved(order: ClosedOrder): boolean {
  if (!terminal(order.status)) return false;
  if (order.status === 'filled' && compareDecimal(order.filled_quantity, order.quantity) !== 0) return false;
  return compareDecimal(order.filled_quantity, '0') === 0 || Boolean(order.provider_symbol && order.exchange_order_id);
}

function flatGroup(group: { side: TradingSide; orders: ClosedOrder[]; fills: OwnershipFill[] }): boolean {
  const markets = new Set(group.orders.filter(order => compareDecimal(order.filled_quantity, '0') > 0).map(order => order.provider_symbol));
  return markets.size <= 1 && proveOwnedQuantity(group.orders, group.fills, group.side).netQuantity === '0';
}

async function localHistoryProof(accountId: string): Promise<LocalLedgerProof | null> {
  const database = getDatabase();
  const pending = await database.get(`SELECT id FROM trading_positions WHERE account_id = ? AND status <> 'closed'
    UNION ALL SELECT id FROM trading_operations WHERE account_id = ? AND phase NOT IN ('resolved', 'abandoned') LIMIT 1`, [accountId, accountId]);
  if (pending) return null;
  const orders = await database.all<ClosedOrder[]>(`SELECT orders.id, orders.intent_id, intent.side AS intent_side, orders.role,
    orders.side, orders.reduce_only, orders.quantity, orders.filled_quantity, orders.status, orders.provider_symbol, orders.exchange_order_id
    FROM trading_orders AS orders JOIN trading_trade_intents AS intent ON intent.id = orders.intent_id WHERE orders.account_id = ? ORDER BY orders.id`, [accountId]);
  if (!orders.every(terminalQuantityProved)) return null;
  const fills = await database.all<Array<OwnershipFill & { intent_id: string }>>(`SELECT fills.order_id, fills.quantity, orders.intent_id
    FROM trading_fills AS fills JOIN trading_orders AS orders ON orders.id = fills.order_id WHERE fills.account_id = ? ORDER BY fills.id`, [accountId]);
  const groups = new Map<string, { side: TradingSide; orders: ClosedOrder[]; fills: OwnershipFill[] }>();
  for (const order of orders) {
    const group = groups.get(order.intent_id) ?? { side: order.intent_side, orders: [], fills: [] };
    group.orders.push(order); groups.set(order.intent_id, group);
  }
  for (const fill of fills) groups.get(fill.intent_id)?.fills.push(fill);
  try { if (![...groups.values()].every(flatGroup)) return null; } catch { return null; }
  return { hash: createHash('sha256').update(JSON.stringify({ orders, fills })).digest('hex'), orderCount: orders.length, fillCount: fills.length };
}

async function baselineRow(account: TradingAccount): Promise<BaselineRow | undefined> {
  return getDatabase().get<BaselineRow>(`SELECT * FROM trading_account_baselines WHERE account_id = ? AND account_fingerprint = ?`,
    [account.id, account.externalAccountId]);
}

async function boundAccountVersion(account: TradingAccount): Promise<number | null> {
  const row = await getDatabase().get<{ state_version: number; external_account_id: string | null; credential_generation: string | null }>(
    'SELECT state_version, external_account_id, credential_generation FROM trading_accounts WHERE id = ?', [account.id]);
  return row?.external_account_id === account.externalAccountId && row?.credential_generation === account.credentialGeneration ? row.state_version : null;
}

async function beginCandidate(account: TradingAccount, acquisition: ExchangeAcquisitionEvidence, localLedger: LocalLedgerProof): Promise<void> {
  const mode = account.exchange === 'bybit' ? await modeBeforeBaseline(account, acquisition) : null;
  if (account.exchange === 'bybit' && !mode && (acquisition.accountMode || await latestAccountMode(account))) return;
  const modeBeforeBoundary = mode && [5, 6].includes(mode.unifiedMarginStatus) ? mode : undefined;
  await getDatabase().run(`INSERT INTO trading_account_baselines (
    id, account_id, account_fingerprint, credential_generation, status, boundary_at, first_completed_at, last_observed_at, first_evidence_json
  ) VALUES (?, ?, ?, ?, 'candidate', ?, ?, ?, ?)
  ON CONFLICT(account_id, account_fingerprint) DO UPDATE SET credential_generation = excluded.credential_generation,
    boundary_at = excluded.boundary_at, first_completed_at = excluded.first_completed_at,
    last_observed_at = excluded.last_observed_at, first_evidence_json = excluded.first_evidence_json
    WHERE trading_account_baselines.status = 'candidate'`,
  [randomUUID(), account.id, account.externalAccountId, account.credentialGeneration, acquisition.startedAt,
    acquisition.completedAt, Date.now(), JSON.stringify({ ...acquisition, localLedger, modeBeforeBoundary })]);
}

async function candidateModePair(account: TradingAccount, previous: BaselineRow, acquisition: ExchangeAcquisitionEvidence):
  Promise<{ first: BybitAccountModeObservation; second: BybitAccountModeObservation } | null | 'pending'> {
  const firstValue = JSON.parse(previous.first_evidence_json).modeBeforeBoundary;
  if (!firstValue) return null; // Legacy baseline: preserve its boundary, without inventing an origin binding.
  const first = validateAccountModeObservation(firstValue), second = acquisition.accountMode?.observation;
  if (!second || second.startedAt <= previous.first_completed_at || !sameUta2Mode(first, second)) return 'pending';
  const latest = await latestAccountMode(account);
  if (latest?.evidenceHash !== second.evidenceHash) return 'pending';
  if (!await consistentModeHistory(account, first, second.completedAt)) return 'pending';
  return { first, second };
}

/** Called under the account coordinator after ingesting all received events; never treats unknown fills as zero. */
export async function observeAccountBaseline(account: TradingAccount, remote: ExchangeOpenState): Promise<void> {
  if (account.exchange === 'paper' || !account.externalAccountId || !account.credentialGeneration) return;
  await withDatabaseTransaction(async () => {
    const version = await boundAccountVersion(account);
    if (version === null) return;
    const previous = await baselineRow(account);
    if (previous?.status === 'established') {
      await classifyPreBaselineHistory(account, previous.id, previous.boundary_at);
      return;
    }
    const acquisition = currentFlatEvidence(account, remote);
    if (!acquisition) return;
    const localLedger = await localHistoryProof(account.id);
    if (!localLedger) return;
    if (!previous || Date.now() - previous.boundary_at > FRESHNESS || previous.credential_generation !== account.credentialGeneration) {
      await beginCandidate(account, acquisition, localLedger);
      return;
    }
    // A replayed or overlapping response cannot serve as the second observation.
    if (acquisition.startedAt <= previous.first_completed_at) return;
    const modePair = await candidateModePair(account, previous, acquisition);
    if (modePair === 'pending') return;
    const proof = { version: 1, accountId: account.id, accountFingerprint: account.externalAccountId,
      credentialGeneration: account.credentialGeneration, accountVersion: version, boundary: previous.boundary_at,
      first: JSON.parse(previous.first_evidence_json), second: acquisition, localTerminalLedgerFlat: true, localLedger };
    const proofJson = JSON.stringify(proof);
    const changed = await getDatabase().run(`UPDATE trading_account_baselines SET status = 'established', last_observed_at = ?, proof_json = ?
      WHERE id = ? AND status = 'candidate'`, [Date.now(), JSON.stringify({ ...proof, evidenceHash: createHash('sha256').update(proofJson).digest('hex') }), previous.id]);
    if (changed.changes !== 1) throw new Error('Account baseline changed before proof commit.');
    if (modePair) await bindPostUta2Baseline(account, previous.id, previous.boundary_at, modePair.first, modePair.second);
    await getDatabase().run(`INSERT INTO trading_risk_events (id, severity, code, account_id, intent_id, details_json, created_at)
      VALUES (?, 'info', 'ACCOUNT_BASELINE_ESTABLISHED', ?, NULL, ?, ?)`, [randomUUID(), account.id,
      JSON.stringify({ baselineId: previous.id, boundary: previous.boundary_at, accountVersion: version,
        explanation: 'Two scoped current observations and a terminal flat owned ledger. Pre-boundary external history only; no account release.' }), Date.now()]);
    await classifyPreBaselineHistory(account, previous.id, previous.boundary_at);
  });
}
