import { fundingTotalValue, validateAccountingEvidence } from './trading_accounting_contract.js';
import { bindAccountReportingCurrency, moneyLedgerSnapshot, recordMoneyEvent } from './trading_money_ledger.js';
import { TradingRiskError } from './trading_risk.js';
import type { TradingAccount, TradingAccountSnapshot, TradingAccountingEvidence } from './trading_types.js';
import { projectAccountFillAccounting } from './trading_fill_accounting.js';
import { assertFundingObservationCurrent } from './trading_funding_observation.js';

function incomplete(reason: string): never {
  throw new TradingRiskError('ACCOUNTING_INCOMPLETE', `Account accounting is incomplete: ${reason}`);
}

export function assertAccountingFresh(evidence: TradingAccountingEvidence, now = Date.now()): void {
  const since = new Date(now).setUTCHours(0, 0, 0, 0);
  if (evidence.observedAt > now + 1000 || now - evidence.observedAt > 60_000
    || evidence.funding.since !== since || evidence.funding.until > evidence.observedAt
    || now - evidence.funding.until > 60_000) incomplete('stale or wrong UTC funding window.');
}

export async function assertPersistedMoneyReady(accountId: string): Promise<void> {
  await projectAccountFillAccounting(accountId);
  const ledger = await moneyLedgerSnapshot(accountId, 0, Number.MAX_SAFE_INTEGER);
  if (ledger.valuationStatus !== 'valued') incomplete('unvalued or conflicting persisted monetary events.');
}

/** Monetary readiness. Protection/exit never depend on success; reconciliation may capture failure as unresolved risk. */
export async function assertEntryAccountingReady(account: TradingAccount, snapshot: TradingAccountSnapshot): Promise<TradingAccountingEvidence> {
  if (!snapshot.accounting) incomplete('missing reporting and funding evidence.');
  let evidence: TradingAccountingEvidence;
  try { evidence = validateAccountingEvidence(snapshot.accounting, snapshot.fundingPnlToday, snapshot.fundingPnlTodayValue); }
  catch { incomplete('invalid reporting or funding contract.'); }
  assertAccountingFresh(evidence);
  try {
    await bindAccountReportingCurrency({ accountId: account.id, accountFingerprint: evidence.accountFingerprint,
      profile: account.exchange, reportingCurrency: evidence.reportingCurrency, settlementAssets: evidence.settlementAssets,
      source: evidence.source, verifiedAt: evidence.observedAt });
    // Individual event transactions preserve contradictory evidence even when a later event blocks admission.
    for (const event of evidence.funding.events) await recordMoneyEvent({
      accountId: account.id, accountFingerprint: evidence.accountFingerprint, providerEventId: event.id,
      kind: 'funding', source: evidence.funding.source, basis: 'provider', occurredAt: event.timestamp,
      amount: event.amount, asset: event.asset,
    });
  } catch { incomplete('currency binding or event conflict.'); }
  if (evidence.unrealizedPnlSemantics !== 'price_only') incomplete('provider unrealized PnL semantics remain unverified.');
  if (evidence.funding.observation) {
    try { await assertFundingObservationCurrent(account, evidence.funding.observation); }
    catch { incomplete('persisted funding observation is stale or unresolved.'); }
  }
  if (fundingTotalValue(evidence.funding, evidence.reportingCurrency) === null) incomplete('funding window or event-time valuation is unresolved.');
  await assertPersistedMoneyReady(account.id);
  return evidence;
}
