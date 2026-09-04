import { getDatabase, withDatabaseTransaction } from './db.js';
import { projectAllFillAccounting } from './trading_fill_accounting.js';
import { getMoneyEvent, moneyLedgerSnapshot } from './trading_money_ledger.js';
import { compareMoneyValue } from './trading_money_risk.js';
import { addMoneyValues, moneyValueFromDecimal, negateMoneyValue, validateMoneyValue, type MoneyValue } from './trading_money_value.js';

export interface ClosedMoneyRow {
  realizedPnl: string | null; reportingCurrency: string | null; accountingStatus: string;
  realizedPnlValue?: MoneyValue | null;
}

export interface MoneySummary {
  realizedPnl: string | null; realizedPnlValue: MoneyValue | null; reportingCurrency: string | null;
  accountingStatus: 'complete' | 'unresolved';
  valuedSubtotalByCurrency: Record<string, string | null>;
  valuedSubtotalValuesByCurrency: Record<string, MoneyValue>;
}
interface ValuedRow { value: MoneyValue; currency: string }
interface MoneyRows { valued: ValuedRow[]; currencies: Map<string, MoneyValue>; unresolved: boolean }

function zero(): MoneyValue { return { ...moneyValueFromDecimal('0'), terms: 0 }; }

function valuedRow(row: ClosedMoneyRow): ValuedRow | null {
  if (row.accountingStatus !== 'complete' || !row.reportingCurrency) return null;
  try {
    if (row.realizedPnlValue === undefined) return row.realizedPnl === null ? null
      : { value: moneyValueFromDecimal(row.realizedPnl), currency: row.reportingCurrency };
    if (row.realizedPnlValue === null) return null;
    const value = validateMoneyValue(row.realizedPnlValue);
    if (row.realizedPnl !== value.decimal) return null;
    return { value, currency: row.reportingCurrency };
  } catch { return null; } // Malformed values/aliases cannot turn into valued zeroes.
}

function groupMoneyRows(rows: ClosedMoneyRow[]): MoneyRows {
  const currencies = new Map<string, MoneyValue>(), valued: ValuedRow[] = [];
  let unresolved = false;
  for (const row of rows) {
    const current = valuedRow(row);
    if (!current) { unresolved = true; continue; }
    valued.push(current);
    currencies.set(current.currency, addMoneyValues(currencies.get(current.currency) ?? zero(), current.value));
  }
  return { currencies, valued, unresolved };
}

function presentSummary(group: MoneyRows, allowEmpty: boolean): MoneySummary {
  const keys = [...group.currencies.keys()];
  const known = !group.unresolved && (keys.length === 1 || (allowEmpty && keys.length === 0));
  const value = known ? group.currencies.get(keys[0]!) ?? zero() : null;
  return { realizedPnl: value?.decimal ?? null, realizedPnlValue: value,
    reportingCurrency: known ? keys[0] ?? null : null, accountingStatus: known ? 'complete' : 'unresolved',
    valuedSubtotalByCurrency: Object.fromEntries([...group.currencies].map(([currency, amount]) => [currency, amount.decimal])),
    valuedSubtotalValuesByCurrency: Object.fromEntries(group.currencies) };
}

export function summarizeMoneyRows(rows: ClosedMoneyRow[]): MoneySummary {
  return presentSummary(groupMoneyRows(rows), false);
}

export interface ClosedMoneyStatistics extends MoneySummary {
  closedTrades: number; wins: number; losses: number; breakeven: number;
  uncertainOutcomeCount: number; grossProfit: string | null; grossLoss: string | null;
  grossProfitValue: MoneyValue | null; grossLossValue: MoneyValue | null;
}

function moneyOutcomes(rows: ValuedRow[]) {
  let wins = 0, losses = 0, breakeven = 0, uncertainOutcomeCount = 0;
  const profit = new Map<string, MoneyValue>(), loss = new Map<string, MoneyValue>();
  for (const { currency, value } of rows) {
    const comparison = compareMoneyValue(value, '0');
    if (comparison === 'uncertain') { uncertainOutcomeCount += 1; continue; }
    if (comparison === 0) { breakeven += 1; continue; }
    if (comparison < 0) {
      losses += 1; loss.set(currency, addMoneyValues(loss.get(currency) ?? zero(), negateMoneyValue(value)));
    } else {
      wins += 1; profit.set(currency, addMoneyValues(profit.get(currency) ?? zero(), value));
    }
  }
  return { wins, losses, breakeven, uncertainOutcomeCount, profit, loss };
}

export function closedMoneyStatistics(rows: ClosedMoneyRow[]): ClosedMoneyStatistics {
  const group = groupMoneyRows(rows), summary = presentSummary(group, true);
  const { profit, loss, ...outcomes } = moneyOutcomes(group.valued);
  const known = summary.accountingStatus === 'complete' && outcomes.uncertainOutcomeCount === 0;
  const currency = summary.reportingCurrency ?? '';
  const grossProfitValue = known ? profit.get(currency) ?? zero() : null;
  const grossLossValue = known ? loss.get(currency) ?? zero() : null;
  return { ...summary, closedTrades: rows.length, ...outcomes,
    grossProfit: grossProfitValue?.decimal ?? null, grossLoss: grossLossValue?.decimal ?? null,
    grossProfitValue, grossLossValue };
}

async function closedPositionRows(channelId: string, accountId: string | null, since: number, until: number) {
  await projectAllFillAccounting();
  return getDatabase().all<Array<ClosedMoneyRow & { valueJson: string | null }>>(`SELECT ledger_realized_pnl AS realizedPnl,
    ledger_realized_value_json AS valueJson,
    reporting_currency AS reportingCurrency, CASE WHEN pending.intent_id IS NOT NULL THEN 'unresolved' ELSE accounting_status END AS accountingStatus
    FROM trading_positions position LEFT JOIN trading_accounting_pending pending ON pending.intent_id = position.intent_id
    WHERE channel_id = ? AND (? IS NULL OR position.account_id = ?) AND status = 'closed' AND closed_at >= ? AND closed_at < ?`,
  [channelId, accountId, accountId, since, until]);
}

/** Explicit full-value API. Adaptive policy callers must migrate their decisions separately. */
export async function channelClosedMoneyValuePerformance(channelId: string, accountId: string | null, since: number, until: number) {
  const rows = await closedPositionRows(channelId, accountId, since, until);
  return closedMoneyStatistics(rows.map(({ valueJson, ...row }) => {
    if (valueJson === null) return row; // Compatible pre-M45 decimal projection.
    try { return { ...row, realizedPnlValue: validateMoneyValue(JSON.parse(valueJson)) }; }
    catch { return { ...row, accountingStatus: 'unresolved', realizedPnlValue: null }; }
  }));
}

/** Legacy scalar policy boundary: do not silently change adaptive rules for rational-only rows. */
export async function channelClosedMoneyPerformance(channelId: string, accountId: string | null, since: number, until: number) {
  const rows = await closedPositionRows(channelId, accountId, since, until);
  const result = closedMoneyStatistics(rows);
  if (result.realizedPnl === null) throw new Error('Channel performance accounting is unresolved or mixes reporting currencies.');
  return { ...result, realizedPnl: result.realizedPnl };
}

function presentedMoneyEvent(row: any, event: Awaited<ReturnType<typeof getMoneyEvent>>, accountReady: boolean) {
  if (!event || event.accountId !== row.accountId || event.occurredAt !== row.occurredAt || event.kind !== row.kind) {
    return { ...row, realizedPnl: null, realizedPnlValue: null, reportingCurrency: null, accountingStatus: 'unresolved' };
  }
  return { ...row, realizedPnl: event.reportingAmount, realizedPnlValue: event.reportingValue,
    reportingCurrency: event.reportingCurrency,
    accountingStatus: accountReady && event.valuationStatus === 'valued' ? 'complete' : 'unresolved' };
}

/** Events are filtered by execution time, independently of whether their intent is still open. */
export async function moneyPerformanceRows(since: number, until: number): Promise<any[]> {
  await projectAllFillAccounting();
  return withDatabaseTransaction(async db => {
    const rows = await db.all<any[]>(`SELECT event.id AS eventId, event.account_id AS accountId, intent.channel_id AS channelId,
    account.exchange, account.mode, intent.status AS intentStatus, event.occurred_at AS occurredAt,
    event.kind FROM trading_money_events event
    JOIN trading_accounts account ON account.id = event.account_id
    LEFT JOIN trading_trade_intents intent ON intent.id = event.intent_id
    WHERE event.occurred_at >= ? AND event.occurred_at < ? ORDER BY event.occurred_at,event.id`, [since, until]);
    const accounts = new Map<string, boolean>(), result = [];
    for (const row of rows) {
      if (!accounts.has(row.accountId)) accounts.set(row.accountId,
        (await moneyLedgerSnapshot(row.accountId, since, until)).valuationStatus === 'valued');
      const event = await getMoneyEvent(row.eventId);
      result.push(presentedMoneyEvent(row, event, accounts.get(row.accountId) === true));
    }
    return result;
  });
}
