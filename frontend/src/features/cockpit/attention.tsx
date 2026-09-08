import { useCallback, useState } from 'react';
import { jsonRequest } from '@/lib/api';
import { usePoll } from '@/shared/api/use-poll';
import { Link, useSearchParams } from '@/lib/navigation';
import { time } from '@/shared/components/operator-primitives';

export function OperatorAttention() {
  const [params, setParams] = useSearchParams(); const cursor = params.get('attentionCursor') || '';
  const [state, setState] = useState<any>(null); const [error, setError] = useState('');
  const read = useCallback((signal: AbortSignal) => jsonRequest(`/api/ui/attention?cursor=${encodeURIComponent(cursor)}`, { signal }), [cursor]);
  usePoll(read, value => { setState({ cursor, value }); setError(''); }, failure => setError(failure.message));
  const data = state?.cursor === cursor ? state.value : null;
  const go = (next?: string) => setParams(previous => { if (next) { previous.set('attentionCursor', next); } else { previous.delete('attentionCursor'); } return previous; });
  return <section className="operations-card space-y-4"><h2>Was Aufmerksamkeit benötigt</h2>
    {error && <p role="alert">{error} · Blockerbeobachtung möglicherweise veraltet.</p>}
    {data?.entries ? <><p>{data.total} gespeicherte Fälle · gelesen {time(data.observedAt)}</p><p>{data.interpretation}</p>
      <ol className="space-y-4">{data.entries.map((entry: any) => <li key={`${entry.kind}:${entry.id}`}><strong>{entry.reason}</strong><p>{entry.kind} {entry.id} · {entry.accountId ? `Konto ${entry.accountId}` : 'Signal-/Versandscope'} · seit {time(entry.createdAt)} · letzter Beleg {time(entry.updatedAt)}</p><Link className="underline" to={entry.nextRead.href}>{entry.nextRead.label}</Link></li>)}</ol>
      {!data.entries.length && <p>Keine gespeicherten Fälle dieser Auswahl. Fehlende Beobachtungen und pausierte Freigaben sind separat zu prüfen.</p>}
      <div className="flex gap-3"><button className="secondary-button" disabled={!cursor} onClick={() => go()}>Aktuelle erste Blockerseite</button><button className="secondary-button" disabled={!data.hasMore} onClick={() => go(data.nextCursor)}>Weitere Blocker</button></div>
    </> : <p><output>Priorisierte Belege werden gelesen …</output></p>}
  </section>;
}
