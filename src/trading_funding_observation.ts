import { getDatabase, withDatabaseTransaction } from './db.js';
import { isDeepStrictEqual } from 'node:util';
import { moneyLedgerSnapshot, valueNativeAccountMoney } from './trading_money_ledger.js';
import { storedAccountLogCheckpoint } from './trading_account_log_repository.js';
import { projectAccountLogMoney } from './trading_account_log_money.js';
import { accountLogDigest, accountLogSource, type FundingObservationProof } from './trading_account_log_contract.js';
import type { TradingAccount, TradingFundingEvidence } from './trading_types.js';
import { accountOriginScope } from './trading_account_mode.js';
import { projectAccountFillAccounting } from './trading_fill_accounting.js';
import { valueFxAccountMoney } from './trading_fx_valuation.js';
import { usesScheduledFxRecovery } from './trading_recovery_schedule_repository.js';

async function observedProof(account: TradingAccount, now: number): Promise<FundingObservationProof> {
  const since = new Date(now).setUTCHours(0, 0, 0, 0);
  const checkpoint = await storedAccountLogCheckpoint(account);
  const rows = await getDatabase().all<Array<{ id: string; status: string; result_json: string | null }>>(`
    SELECT receipt.id,work.status,work.result_json FROM trading_account_log_receipts receipt
      JOIN trading_account_log_consumers work ON work.receipt_id=receipt.id AND work.consumer='money'
    WHERE receipt.account_id=? AND receipt.account_fingerprint=? ORDER BY receipt.sequence`, [account.id, account.externalAccountId]);
  const ledger = await moneyLedgerSnapshot(account.id, since, now + 1);
  const through = checkpoint?.scannedThrough ?? since;
  const source = accountLogSource(account.exchange);
  const origin = account.exchange === 'bybit' ? await accountOriginScope(account, since) : null;
  const scopeReason = origin?.status === 'not_proven' ? `source_origin:${origin.reason}` : null;
  const reason = scopeReason ?? observationReason({ checkpoint, since, through, now, rows, valued: ledger.valuationStatus === 'valued' });
  return { version: 1, status: reason === null ? 'observed' : 'incomplete', namespace: source?.namespace ?? 'unsupported',
    accountFingerprint: account.externalAccountId ?? '', credentialGeneration: account.credentialGeneration ?? '',
    since, through, revisionHash: accountLogDigest([checkpoint, rows, ledger, origin]), reportingCurrency: ledger.reportingCurrency,
    amount: reason === null ? ledger.funding : null, value: reason === null ? ledger.fundingValue : null,
    sourceScope: 'source_account', finality: 'provider_as_observed',
    delivery: 'may_be_delayed', reason };
}
function observationReason(input: { checkpoint: Awaited<ReturnType<typeof storedAccountLogCheckpoint>>; since: number; through: number;
  now: number; rows: Array<{ status: string }>; valued: boolean }): string | null {
  const { checkpoint, since, through, now, rows, valued } = input;
  if (!checkpoint) return 'source_unsupported';
  if (through < since || now - through > 60000) return 'funding_window_not_fresh';
  if (rows.length === 0 || rows.some(row => row.status !== 'complete')) return 'unresolved_monetary_source';
  if (!valued) return 'unvalued_monetary_events';
  return checkpoint.reason && checkpoint.reason !== 'budget_exhausted' ? checkpoint.reason : null;
}

export async function observedFundingEvidence(account: TradingAccount, now = Date.now()): Promise<TradingFundingEvidence> {
  await projectAccountFillAccounting(account.id);
  await projectAccountLogMoney(account);
  if (account.externalAccountId) await valueNativeAccountMoney(account.id, account.externalAccountId);
  // Only already retained, account/profile-bound stablecoin originals are eligible.
  // This bounded replay makes no provider read and cannot relax source or entry-safety gates.
  if (usesScheduledFxRecovery(account)) await valueFxAccountMoney(account);
  // A newly proved native or FX valuation enqueues its existing intent. Rebuild
  // that bounded local projection before reporting this same observation; no extra provider read.
  await projectAccountFillAccounting(account.id);
  const observation = await withDatabaseTransaction(() => observedProof(account, now));
  return { status: observation.status === 'observed' ? 'complete' : 'incomplete', since: observation.since,
    until: Math.max(observation.since, observation.through), cursor: null, source: observation.namespace, reason: observation.reason,
    nextReadAt: 0, events: [], observation };
}

/** Recheck the actual durable source generation, not a caller-supplied aggregate. */
export async function assertFundingObservationCurrent(account: TradingAccount, proof: FundingObservationProof): Promise<void> {
  const current = await observedProof(account, Date.now());
  // A legacy decimal-only proof may omit the additive value, but cannot stand in
  // for an exact rational with no decimal representation. All original bindings remain compared.
  const comparable = { ...current };
  if (proof.value === undefined && proof.amount !== null && current.amount !== null) delete comparable.value;
  if (proof.status !== 'observed' || current.status !== 'observed'
    || !isDeepStrictEqual(proof, comparable)) {
    throw new Error('Persisted funding observation is stale or unresolved.');
  }
}
