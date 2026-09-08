import { addSignedDecimal, signedDecimal } from '../../../../src/trading_decimal';

/** Display aggregation of the existing account snapshot, never an entry/risk decision. */
export function portfolioTotal(accounts: any[] | undefined, key: string): string {
  if (!accounts) return 'nicht verfügbar';
  if (!accounts.length) return 'keine Kontobelege';
  const totals = new Map<string, string>(); let unknown = 0;
  for (const account of accounts) {
    if (account.error || !Number.isSafeInteger(account.observedAt) || account.observedAt <= 0 || !['paper', 'testnet', 'live'].includes(account.mode) || typeof account[key] !== 'string' || !/^[A-Z0-9]{2,12}$/.test(account.reportingCurrency ?? '')) { unknown++; continue; }
    const group = `${account.reportingCurrency} (${account.mode})`;
    try { totals.set(group, addSignedDecimal(totals.get(group) ?? '0', signedDecimal(account[key]))); }
    catch { unknown++; }
  }
  const known = [...totals].map(([currency, value]) => `${value.replace('.', ',')} ${currency}`).join(' · ');
  const unknownNotice = unknown ? ` · ${unknown} Kontobeleg(e) ungeklärt; keine Gesamtsumme` : '';
  return `${known || 'nicht verfügbar'}${unknownNotice}`;
}
