import { addSignedDecimal, signedDecimal } from '../../../../src/trading_decimal';

type PortfolioObservation = Record<string, unknown>;
function observedTimestamp(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function observedMode(value: unknown) {
  return value === 'paper' || value === 'testnet' || value === 'live';
}
function observedCurrency(value: unknown) {
  return typeof value === 'string' && /^[A-Z0-9]{2,12}$/u.test(value);
}
function portfolioGroup(account: PortfolioObservation): string | null {
  if (account.error || !observedTimestamp(account.observedAt) || !observedMode(account.mode) || !observedCurrency(account.reportingCurrency)) return null;
  return `${account.reportingCurrency} (${account.mode})`;
}
function portfolioEntry(account: PortfolioObservation, key: string) {
  const group = portfolioGroup(account);
  const amount = account[key];
  if (!group || typeof amount !== 'string') return null;
  return { group, amount };
}
function aggregatePortfolio(accounts: PortfolioObservation[], key: string) {
  const totals = new Map<string, string>(); let unknown = 0;
  for (const account of accounts) {
    const entry = portfolioEntry(account, key);
    if (!entry) { unknown++; continue; }
    try { totals.set(entry.group, addSignedDecimal(totals.get(entry.group) ?? '0', signedDecimal(entry.amount))); }
    catch { unknown++; }
  }
  return { totals, unknown };
}

/** Display aggregation of the existing account snapshot, never an entry/risk decision. */
export function portfolioTotal(accounts: PortfolioObservation[] | undefined, key: string): string {
  if (!accounts) return 'nicht verfügbar';
  if (!accounts.length) return 'keine Kontobelege';
  const { totals, unknown } = aggregatePortfolio(accounts, key);
  const known = [...totals].map(([currency, value]) => `${value.replace('.', ',')} ${currency}`).join(' · ');
  const unknownNotice = unknown ? ` · ${unknown} Kontobeleg(e) ungeklärt; keine Gesamtsumme` : '';
  return `${known || 'nicht verfügbar'}${unknownNotice}`;
}
