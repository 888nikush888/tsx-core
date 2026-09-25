import { getDatabase } from './db.js';
import { reviewHash } from './ui_change_review.js';

export function paperConfigurationRevision(kind: 'market' | 'balance', row: Record<string, unknown> | null): string | null {
  if (!row) return null;
  const keys = kind === 'market' ? ['accountId', 'symbol', 'markPrice', 'priceTick', 'quantityStep', 'minimumQuantity', 'minimumNotional', 'maxLeverage', 'updatedAt']
    : ['accountId', 'equity', 'availableBalance', 'realizedPnl', 'updatedAt'];
  return reviewHash(Object.fromEntries(keys.map((key): [string, unknown] => [key, row[key]])));
}
export async function readPaperConfiguration(accountId: string, symbol = '') {
  const database = getDatabase();
  const balance = await database.get('SELECT account_id AS accountId, equity, available_balance AS availableBalance, realized_pnl AS realizedPnl, updated_at AS updatedAt FROM trading_paper_accounts WHERE account_id = ?', [accountId]);
  const market = symbol ? await database.get('SELECT account_id AS accountId, symbol, mark_price AS markPrice, price_tick AS priceTick, quantity_step AS quantityStep, minimum_quantity AS minimumQuantity, minimum_notional AS minimumNotional, max_leverage AS maxLeverage, updated_at AS updatedAt FROM trading_paper_markets WHERE account_id = ? AND symbol = ?', [accountId, symbol.trim().toUpperCase()]) : null;
  return { balance: balance ? { ...balance, revision: paperConfigurationRevision('balance', balance), reportingCurrency: 'USDT', source: 'paper-contract-v1' } : null,
    market: market ? { ...market, revision: paperConfigurationRevision('market', market) } : null };
}
export async function assertPaperConfigurationRevision(accountId: string, payload: Record<string, unknown>): Promise<void> {
  const symbol = (payload.market as { symbol?: unknown } | null | undefined)?.symbol ?? '';
  if (typeof symbol !== 'string') throw new Error('Paper market symbol must be a string.');
  const current = await readPaperConfiguration(accountId, symbol);
  for (const [kind, field] of [['market', 'baseMarketRevision'], ['balance', 'baseBalanceRevision']] as const) {
    const expected = payload[field];
    if (expected === undefined) continue; // Existing service/CLI callers retain their contract; UI always binds the observed state.
    if (expected !== null && (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected))) throw new Error('Invalid Paper configuration revision.');
    if ((current[kind]?.revision ?? null) !== expected) throw new Error('PAPER_CONFIGURATION_CONFLICT: Paper state changed. Reload and compare before applying.');
  }
}
