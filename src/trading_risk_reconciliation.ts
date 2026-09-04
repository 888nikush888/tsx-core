import { assertEntryAccountingReady } from './trading_accounting.js';
import { moneyLedgerSnapshot } from './trading_money_ledger.js';
import { calculateMonetaryDailyRisk } from './trading_money_risk.js';
import { moneyValueFromDecimal } from './trading_money_value.js';
import { existingRiskCommitment, observeRiskReservations, recordRiskBalance, riskExposureExists } from './trading_risk_repository.js';
import type { ExchangeOpenState, TradingAccount, TradingAccountSnapshot } from './trading_types.js';

/** Exactly one bounded balance read after the entire ownership/protection loop, never per intermediate pass. */
export async function refreshReconciledRisk(input: { account: TradingAccount; remote: ExchangeOpenState; epoch: string;
  readBalance: () => Promise<TradingAccountSnapshot>; budgetForIntent: (id: string, equity: string) => Promise<string> }): Promise<boolean> {
  const { account, remote, epoch } = input;
  let snapshot: TradingAccountSnapshot | null = null;
  let reason: string | null = null;
  const exposed = await riskExposureExists(account.id);
  if (exposed) {
    try { snapshot = await input.readBalance(); await assertEntryAccountingReady(account, snapshot); }
    catch (error) { snapshot = null; reason = error instanceof Error ? error.message : 'Current account money evidence is unresolved.'; }
  }
  const observationId = await observeRiskReservations(account, remote, epoch);
  let exceeded = false;
  if (snapshot) {
    try {
      const reserve = await existingRiskCommitment(account, '', epoch, snapshot.accounting!.reportingCurrency);
      const now = Date.now();
      const ledger = await moneyLedgerSnapshot(account.id, new Date(now).setUTCHours(0, 0, 0, 0), now + 1);
      if (ledger.valuationStatus !== 'valued' || ledger.value === null) throw new Error('Current account ledger is unresolved.');
      if (ledger.reportingCurrency !== snapshot.accounting!.reportingCurrency) throw new Error('Risk reporting currency differs from the bound ledger.');
      for (const reservation of reserve.reservations) {
        const budget = await input.budgetForIntent(reservation.intentId, snapshot.equity);
        const result = calculateMonetaryDailyRisk({ budget, ledgerPnl: ledger.value, unrealizedPnl: snapshot.unrealizedPnl,
          existingCommitment: reserve.value, candidateCommitment: moneyValueFromDecimal('0') });
        if (result.breached) exceeded = true;
        else if (!result.allowed) reason = 'RISK_PRECISION_UNCERTAIN';
      }
      if (exceeded) reason = 'MAX_DAILY_RISK';
    } catch (error) { reason = error instanceof Error ? error.message : 'Risk evidence is unresolved.'; }
  }
  await recordRiskBalance(account.id, observationId, snapshot, reason);
  return exceeded;
}
