import { assertEntryAccountingReady } from './trading_accounting.js';
import { moneyLedgerSnapshot } from './trading_money_ledger.js';
import { calculateMonetaryDailyRisk } from './trading_money_risk.js';
import { moneyValueFromDecimal } from './trading_money_value.js';
import { existingRiskCommitment, observeRiskReservations, recordRiskBalance, riskExposureExists } from './trading_risk_repository.js';
import type { ExchangeOpenState, TradingAccount, TradingAccountSnapshot } from './trading_types.js';

interface ReconciledRiskInput { account: TradingAccount; remote: ExchangeOpenState; epoch: string;
  readBalance: () => Promise<TradingAccountSnapshot>; budgetForIntent: (id: string, equity: string) => Promise<string> }

async function currentRiskSnapshot(input: ReconciledRiskInput, exposed: boolean): Promise<{
  snapshot: TradingAccountSnapshot | null; reason: string | null }> {
  if (!exposed) return { snapshot: null, reason: null };
  try {
    const snapshot = await input.readBalance();
    await assertEntryAccountingReady(input.account, snapshot);
    return { snapshot, reason: null };
  } catch (error) {
    return { snapshot: null, reason: error instanceof Error ? error.message : 'Current account money evidence is unresolved.' };
  }
}

async function reconciledRiskStatus(input: ReconciledRiskInput, snapshot: TradingAccountSnapshot): Promise<{
  exceeded: boolean; reason: string | null }> {
  let exceeded = false;
  try {
    const reserve = await existingRiskCommitment(input.account, '', input.epoch, snapshot.accounting!.reportingCurrency);
    const now = Date.now();
    const ledger = await moneyLedgerSnapshot(input.account.id, new Date(now).setUTCHours(0, 0, 0, 0), now + 1);
    if (ledger.valuationStatus !== 'valued' || ledger.value === null) throw new Error('Current account ledger is unresolved.');
    if (ledger.reportingCurrency !== snapshot.accounting!.reportingCurrency) throw new Error('Risk reporting currency differs from the bound ledger.');
    let reason: string | null = null;
    for (const reservation of reserve.reservations) {
      const budget = await input.budgetForIntent(reservation.intentId, snapshot.equity);
      const result = calculateMonetaryDailyRisk({ budget, ledgerPnl: ledger.value, unrealizedPnl: snapshot.unrealizedPnl,
        existingCommitment: reserve.value, candidateCommitment: moneyValueFromDecimal('0') });
      if (result.breached) exceeded = true;
      else if (!result.allowed) reason = 'RISK_PRECISION_UNCERTAIN';
    }
    return { exceeded, reason: exceeded ? 'MAX_DAILY_RISK' : reason };
  } catch (error) {
    return { exceeded, reason: error instanceof Error ? error.message : 'Risk evidence is unresolved.' };
  }
}

/** Exactly one bounded balance read after the entire ownership/protection loop, never per intermediate pass. */
export async function refreshReconciledRisk(input: ReconciledRiskInput): Promise<boolean> {
  const { account, remote, epoch } = input;
  const exposed = await riskExposureExists(account.id);
  const current = await currentRiskSnapshot(input, exposed);
  const observationId = await observeRiskReservations(account, remote, epoch);
  const status = current.snapshot ? await reconciledRiskStatus(input, current.snapshot) : { exceeded: false, reason: current.reason };
  await recordRiskBalance(account.id, observationId, current.snapshot, status.reason);
  return status.exceeded;
}
