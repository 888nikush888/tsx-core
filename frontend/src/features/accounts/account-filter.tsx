import { useCallback, useState } from 'react';
import { jsonRequest } from '@/lib/api';
import { usePoll } from '@/shared/api/use-poll';

type AccountOption = { id: string; name: string; exchange: string; mode: string; retiredAt: number | null };
type AccountPage = { entries: AccountOption[]; hasMore: boolean; nextCursor: string | null };
type AccountObservation = { cursor: string; page: AccountPage };

/** Keeps the selected original ID even when it is absent from the current metadata page. */
export function AccountFilter({ value, onChange }: Readonly<{ value: string; onChange: (value: string) => void }>) {
  const [cursor, setCursor] = useState(''); const [state, setState] = useState<AccountObservation | null>(null); const [error, setError] = useState('');
  const read = useCallback(async (signal: AbortSignal) => ({ cursor, page: await jsonRequest(`/api/trading/objects?kind=accounts&limit=30&cursor=${encodeURIComponent(cursor)}`, { signal }) }), [cursor]);
  usePoll(read, result => { setState(result); setError(''); }, failure => setError(failure.message));
  const page = state?.cursor === cursor ? state.page : null; const entries = page?.entries ?? [];
  return <div className="space-y-1"><label>Konto<select value={value} onChange={event => onChange(event.target.value)}>
    <option value="">Alle Konten</option>{entries.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.exchange}/{account.mode}{account.retiredAt ? ' · historisch' : ''}</option>)}
    {value && !entries.some((account) => account.id === value) && <option value={value}>Gewähltes Originalkonto {value}</option>}
  </select></label><div className="flex gap-2"><button className="secondary-button" disabled={!cursor} onClick={() => setCursor('')}>Kontenauswahl Anfang</button><button className="secondary-button" disabled={!page?.hasMore} onClick={() => { if (page?.nextCursor) setCursor(page.nextCursor); }}>Weitere Konten zur Auswahl</button></div>
  {error && <small role="alert">Kontenauswahl: {error}</small>}</div>;
}
