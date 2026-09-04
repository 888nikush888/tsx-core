import { getDatabase, withDatabaseTransaction } from './db.js';
import { moneyValueFromDecimal, type MoneyValue } from './trading_money_value.js';
import { calculateMonetaryDailyRisk } from './trading_money_risk.js';
import { assertAccountingFresh } from './trading_accounting.js';
import { moneyLedgerSnapshot } from './trading_money_ledger.js';
import { assertRiskFresh, RISK_EVIDENCE_TTL_MS } from './trading_risk_reservations.js';
import { assertRiskFxFresh, assertRiskSizingBinding, calculateFxRiskReservation, verifyRiskFxConversions } from './trading_fx_risk.js';
import { snapshotFxAccount, type FxAccount, type StoredFxConversion } from './trading_fx_repository.js';
import { existingRiskCommitment, type ExistingRiskProof } from './trading_risk_repository.js';
import { loadRiskSources, riskFingerprint, riskHash } from './trading_risk_sources.js';
import { TradingRiskError } from './trading_risk.js';
import type { TradingAccount, TradingAccountSnapshot, TradingMarketSnapshot, TradingPlan } from './trading_types.js';

export interface RiskAdmissionProof {
  accountId: string; intentId: string; fingerprint: string; credentialGeneration: string | null; epoch: string;
  accountSnapshot: TradingAccountSnapshot; marketObservedAt: number; existing: ExistingRiskProof;
  candidateCommitment: string | null; candidateValue: MoneyValue; candidateHash: string; ledgerHash: string; budget: string;
  fxAccount: FxAccount; fxConversions: StoredFxConversion[];
}
function unavailable(reason: string): never { throw new TradingRiskError('RISK_EVIDENCE_UNRESOLVED', `Risk admission is unresolved: ${reason}`); }

async function assertStoredCandidate(proof: RiskAdmissionProof, plan: TradingPlan): Promise<void> {
  const row = await getDatabase().get<{ plan_json: string | null }>('SELECT plan_json FROM trading_trade_intents WHERE id = ?', [proof.intentId]);
  if (!row?.plan_json || riskHash(JSON.parse(row.plan_json)) !== proof.candidateHash) unavailable('persisted candidate changed.');
  const orders = await getDatabase().all<Array<{ client_order_id: string; price: string | null; trigger_price: string | null;
    quantity: string; order_type: string; side: string; reduce_only: number; filled_quantity: string }>>(
    "SELECT client_order_id, price, trigger_price, quantity, order_type, side, reduce_only, filled_quantity FROM trading_orders WHERE intent_id = ? AND role IN ('entry', 'stop_loss')", [proof.intentId]);
  for (const expected of plan.orders.filter(order => ['entry', 'stop_loss'].includes(order.role))) {
    const actual = orders.find(order => order.client_order_id === expected.clientOrderId);
    if (!actual || actual.quantity !== expected.quantity || actual.price !== expected.price || actual.trigger_price !== expected.triggerPrice
      || actual.order_type !== expected.orderType || actual.side !== expected.side || actual.reduce_only !== Number(expected.reduceOnly)
      || actual.filled_quantity !== '0') unavailable('persisted candidate order economics changed.');
  }
}

async function dailyLedger(accountId: string) {
  const now = Date.now();
  const since = new Date(now).setUTCHours(0, 0, 0, 0);
  const ledger = await moneyLedgerSnapshot(accountId, since, now + 1);
  if (ledger.valuationStatus !== 'valued' || ledger.value === null) throw new TradingRiskError('ACCOUNTING_INCOMPLETE', 'Daily monetary evidence remains unresolved.');
  const events = await getDatabase().all(`SELECT event.id, event.content_json, valuation.content_json AS valuation FROM trading_money_events event
    LEFT JOIN trading_money_valuations valuation ON valuation.event_id = event.id WHERE event.account_id = ? ORDER BY event.id`, [accountId]);
  const funding = await getDatabase().all(`SELECT checkpoint.payload_json,receipt.id,work.status,work.result_json
    FROM trading_account_log_checkpoints checkpoint LEFT JOIN trading_account_log_receipts receipt ON receipt.account_id=checkpoint.account_id
    LEFT JOIN trading_account_log_consumers work ON work.receipt_id=receipt.id AND work.consumer='money'
    WHERE checkpoint.account_id=? ORDER BY receipt.sequence`, [accountId]);
  return { ...ledger, value: ledger.value, hash: riskHash([ledger, events, funding]) };
}

function assertDailyBudget(budget: string, ledgerPnl: MoneyValue, unrealizedPnl: string, existing: MoneyValue, candidate: MoneyValue): void {
  const result = calculateMonetaryDailyRisk({ budget, ledgerPnl, unrealizedPnl,
    existingCommitment: existing, candidateCommitment: candidate });
  if (result.allowed) return;
  if (!result.breached) throw new TradingRiskError('RISK_PRECISION_UNCERTAIN', 'Bounded monetary precision cannot prove that the candidate fits the daily budget.');
  throw new TradingRiskError(result.lossLimitReached ? 'MAX_DAILY_LOSS' : 'MAX_DAILY_RISK',
    'Account current loss plus proved current commitments exceeds the daily-loss budget.');
}

async function candidateReservation(account: FxAccount, plan: TradingPlan, market: TradingMarketSnapshot, reportingCurrency: string) {
  const entry = plan.orders.find(order => order.role === 'entry');
  if (!entry || entry.orderType !== 'limit') unavailable('entry has no bounded executable price.');
  return calculateFxRiskReservation(account, { side: plan.side, ownedQuantity: '0', averageEntryPrice: null, markPrice: null,
    stopPrice: plan.stopPrice, reportingCurrency, market: market.accounting ?? null,
    protectionProven: true, entries: [{ id: entry.clientOrderId, generation: 0, status: 'created', quantity: entry.quantity,
      filledQuantity: '0', price: entry.price, operationUnresolved: false }] }, market.observedAt);
}

export async function createRiskAdmission(input: { account: TradingAccount; intentId: string; plan: TradingPlan;
  market: TradingMarketSnapshot; snapshot: TradingAccountSnapshot; budget: string; epoch: string;
  sizingFx?: StoredFxConversion }): Promise<RiskAdmissionProof> {
  const fxAccount = snapshotFxAccount(input.account);
  const sizingFx = input.sizingFx ? structuredClone(input.sizingFx) : null;
  return withDatabaseTransaction(async () => {
    const { account, plan, market, snapshot, epoch } = input;
    if (!snapshot.accounting) unavailable('missing reporting evidence.');
    try { assertRiskSizingBinding(plan.fxSizing, sizingFx, snapshot.accounting.reportingCurrency, market.accounting?.settlementAsset); }
    catch (error) { unavailable(error instanceof Error ? error.message : 'Sizing evidence unresolved.'); }
    const ledger = await dailyLedger(account.id);
    if (ledger.reportingCurrency !== snapshot.accounting.reportingCurrency) unavailable('reporting currency differs from the bound ledger.');
    const knownLoss = calculateMonetaryDailyRisk({ budget: input.budget, ledgerPnl: ledger.value, unrealizedPnl: snapshot.unrealizedPnl,
      existingCommitment: moneyValueFromDecimal('0'), candidateCommitment: moneyValueFromDecimal('0') });
    if (knownLoss.lossLimitReached) throw new TradingRiskError('MAX_DAILY_LOSS', 'Account daily-loss limit is reached.');
    const existing = await existingRiskCommitment(account, input.intentId, epoch, snapshot.accounting.reportingCurrency);
    const { amounts: candidate, fx } = await candidateReservation(fxAccount, plan, market, snapshot.accounting.reportingCurrency);
    if (candidate.additionalRiskValue === null) unavailable(candidate.reason ?? 'candidate settlement unknown.');
    const fxConversions = [...existing.fxConversions, ...(fx ? [fx] : []), ...(sizingFx ? [sizingFx] : [])];
    try { await verifyRiskFxConversions(fxAccount, fxConversions); }
    catch (error) { unavailable(error instanceof Error ? error.message : 'FX originals unresolved.'); }
    assertDailyBudget(input.budget, ledger.value, snapshot.unrealizedPnl, existing.value, candidate.additionalRiskValue);
    const proof = { accountId: account.id, intentId: input.intentId, fingerprint: riskFingerprint(account),
      credentialGeneration: account.credentialGeneration, epoch, accountSnapshot: snapshot, marketObservedAt: market.observedAt,
      existing, candidateCommitment: candidate.additionalRisk, candidateValue: candidate.additionalRiskValue,
      fxAccount, fxConversions, candidateHash: riskHash(plan), ledgerHash: ledger.hash, budget: input.budget };
    assertRiskAdmissionFresh(proof);
    return proof;
  });
}

/** Last synchronous time fence; called immediately before adapter dispatch, with the coordinator epoch guard. */
export function assertRiskAdmissionFresh(proof: RiskAdmissionProof): void {
  try {
    const now = Date.now();
    assertAccountingFresh(proof.accountSnapshot.accounting!);
    assertRiskFxFresh(proof.fxConversions, now);
    assertRiskFresh(proof.existing, now);
    for (const observedAt of [proof.marketObservedAt, proof.accountSnapshot.accounting!.observedAt]) assertRiskFresh({ observedAt,
      expiresAt: observedAt + RISK_EVIDENCE_TTL_MS, utcDay: proof.existing.utcDay }, now);
  } catch { unavailable('stale account, market, funding or UTC evidence.'); }
}

function assertSizingDependency(proof: RiskAdmissionProof, plan: TradingPlan): void {
  try { assertRiskSizingBinding(plan.fxSizing, plan.fxSizing
    ? proof.fxConversions.find(fx => fx.id === plan.fxSizing!.conversionId) ?? null : null,
  proof.accountSnapshot.accounting!.reportingCurrency, plan.fxSizing?.notionalCurrency); }
  catch (error) { unavailable(error instanceof Error ? error.message : 'Sizing evidence unresolved.'); }
}

/** Read-only under the dispatch fence after the durable journal transition. */
export async function verifyRiskAdmission(proof: RiskAdmissionProof, plan: TradingPlan): Promise<void> {
  assertRiskAdmissionFresh(proof);
  if (proof.candidateHash !== riskHash(plan)) unavailable('candidate changed.');
  assertSizingDependency(proof, plan);
  await assertStoredCandidate(proof, plan);
  const account = await getDatabase().get<{ external_account_id: string | null; credential_generation: string | null; exchange: string }>(
    'SELECT external_account_id, credential_generation, exchange FROM trading_accounts WHERE id = ?', [proof.accountId]);
  const fingerprint = account?.exchange === 'paper' ? `paper:${proof.accountId}` : account?.external_account_id;
  if (fingerprint !== proof.fingerprint || account?.credential_generation !== proof.credentialGeneration) unavailable('account identity changed.');
  try { await verifyRiskFxConversions(proof.fxAccount, proof.fxConversions); }
  catch (error) { unavailable(error instanceof Error ? error.message : 'FX originals unresolved.'); }
  const source = await loadRiskSources(proof.accountId, proof.intentId);
  if (riskHash(source) !== proof.existing.sourceHash) unavailable('order, fill, stop or operation sources changed.');
  const ledger = await dailyLedger(proof.accountId);
  if (ledger.reportingCurrency !== proof.accountSnapshot.accounting!.reportingCurrency) unavailable('reporting currency differs from the bound ledger.');
  if (ledger.hash !== proof.ledgerHash) unavailable('monetary evidence changed.');
  assertDailyBudget(proof.budget, ledger.value, proof.accountSnapshot.unrealizedPnl, proof.existing.value, proof.candidateValue);
  assertRiskAdmissionFresh(proof);
}
