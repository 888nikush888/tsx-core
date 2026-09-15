import { useCallback, useState } from 'react';
import { jsonRequest } from '@/lib/api';
import { Link, useSearchParams } from '@/lib/navigation';
import { usePoll } from '@/shared/api/use-poll';
import { useOperatorReadOnly } from '@/shared/api/operator-session';
import { Accounts, type AccountManagementSnapshot } from './accounts';
import type { ExchangeCatalog } from '@/app/workflow/types';

type AccountsResponse = AccountManagementSnapshot & {
  interpretation?: string;
  incidentsHaveMore?: boolean;
  page?: { hasMore: boolean; nextCursor: string | null };
};
type AccountsObservation = { query: string; value: AccountsResponse };

export function AccountsPage({ catalog, accountId, onRefresh }: Readonly<{ catalog: ExchangeCatalog | null; accountId?: string; onRefresh?: () => Promise<void> }>) {
  const readOnly = useOperatorReadOnly(); const [params, setParams] = useSearchParams(); const cursor = params.get('accountsCursor') || '';
  const query = new URLSearchParams({ view: 'accounts', cursor, ...(accountId ? { accountId } : {}) }).toString();
  const [state, setState] = useState<AccountsObservation | null>(null); const [error, setError] = useState(''); const [refresh, setRefresh] = useState(0);
  const read = useCallback((signal: AbortSignal) => jsonRequest(`/api/trading?${query}`, { signal }), [query]);
  usePoll(read, value => { setState({ query, value }); setError(''); }, failure => setError(failure.message), 5000, refresh);
  const data = state?.query === query ? state.value : null; const reload = useCallback(async () => { setRefresh(value => value + 1); await onRefresh?.(); }, [onRefresh]);
  const go = (next?: string | null) => setParams(previous => { if (next) { previous.set('accountsCursor', next); } else { previous.delete('accountsCursor'); } return previous; });
  const incidentAccountQuery = accountId ? `&accountId=${encodeURIComponent(accountId)}` : "";
  return <section aria-label="Trading" className="space-y-4"><h1>{accountId ? 'Aktionen dieses Kontos' : 'Konten und Börsen'}</h1>
    {error && <p role="alert">{error} · Kontoseite möglicherweise veraltet.</p>}
    {data ? <><p>{data.interpretation}</p><p>{data.accounts.length} Konten auf dieser Seite{data.page?.hasMore ? ' · weitere vorhanden' : ''}.</p>
      {data.incidentsHaveMore && <p>Die Vorfallübersicht ist ein Ausschnitt. <Link to={`/trading/incidents?status=open${incidentAccountQuery}`}>Alle offenen Vorfälle lesen</Link></p>}
      <fieldset disabled={readOnly} className="min-w-0 border-0 p-0"><Accounts trading={data} catalog={catalog} onRefresh={reload} /></fieldset>
      {!accountId && <div className="flex gap-3"><button className="secondary-button" disabled={!cursor} onClick={() => go()}>Erste Kontoseite</button><button className="secondary-button" disabled={!data.page?.hasMore} onClick={() => go(data.page?.nextCursor)}>Weitere Konten</button></div>}
    </> : <p><output>Konten werden gelesen …</output></p>}
  </section>;
}
