import { useCallback, useState } from 'react';
import { jsonRequest } from '@/lib/api';
import { Link, useSearchParams } from '@/lib/navigation';
import { usePoll } from '@/shared/api/use-poll';
import { EvidenceTable } from '@/shared/components/evidence';
import { RiskAcknowledgment } from '@/features/risk-analytics/risk-acknowledgment';

const LISTS = {
  'risk-events': { title: 'Risikoereignisse', columns: [['code', 'Ursache'], ['severity', 'Schwere'], ['status', 'Quittierungsstatus'], ['acknowledgment', 'Operatorprüfung']] },
  positions: { title: 'Positionen', columns: [['symbol', 'Symbol'], ['side', 'Seite'], ['status', 'Positionsstatus'], ['quantity', 'Restmenge (Repository)'], ['averageEntryPrice', 'Fill-Durchschnitt'], ['stopPrice', 'Gemeldeter Stop']] },
  orders: { title: 'Orders', columns: [['role', 'Geplante Rolle'], ['status', 'Orderstatus'], ['quantity', 'Menge'], ['filledQuantity', 'Kumulativ gefüllt'], ['triggerPrice', 'Trigger'], ['cancelRequestedAt', 'Cancel angefordert (UTC ms)'], ['cancelAttemptedAt', 'Cancel versucht (UTC ms)'], ['reason', 'Grund']] },
  operations: { title: 'Börsenoperationen', columns: [['kind', 'Command'], ['generation', 'Generation'], ['status', 'Operationszustand'], ['requestHash', 'Requesthash'], ['reason', 'Grund']] },
  incidents: { title: 'Konto-Vorfälle', columns: [['category', 'Kategorie'], ['severity', 'Schwere'], ['status', 'Vorfallsstatus'], ['reason', 'Grund'], ['occurrences', 'Beobachtungen']] },
  reconciliations: { title: 'REST-Abgleiche', columns: [['status', 'Abgleichstatus'], ['startedAt', 'Beginn (UTC ms)'], ['completedAt', 'Abschluss (UTC ms)'], ['reason', 'Grund']] },
} as const;
export type TradingListKind = keyof typeof LISTS;

export function TradingList({ kind }: Readonly<{ kind: TradingListKind }>) {
  const [params, setParams] = useSearchParams();
  const [state, setState] = useState<any>(null); const [error, setError] = useState('');
  const query = new URLSearchParams(params); query.set('kind', kind); const key = query.toString();
  const read = useCallback((signal: AbortSignal) => jsonRequest(`/api/trading/objects?${key}`, { signal }), [key]);
  usePoll(read, (value) => { setState({ key, value }); setError(''); }, (reason) => setError(reason.message));
  const page = state?.key === key ? state.value : null;
  const change = (name: string, value: string) => { const next = new URLSearchParams(params); next.delete('cursor'); if (value) { next.set(name, value); } else { next.delete(name); } setParams(next); };
  const entries = (page?.entries ?? []).map((entry: any) => ({ ...entry, id: entry.intentId ? <Link to={`/trading/trades/${encodeURIComponent(entry.intentId)}`}>{entry.id}</Link> : entry.id, accountId: entry.accountId ? <Link to={`/trading/accounts/${encodeURIComponent(entry.accountId)}`}>{entry.accountId}</Link> : 'global', acknowledgment: kind === 'risk-events' ? <RiskAcknowledgment key={entry.id} id={entry.id} acknowledgedAt={entry.acknowledgedAt} /> : null }));
  return <div className="operations-stack"><h1>{LISTS[kind].title}</h1>
    <div className="operations-card system-form flex flex-wrap gap-4"><label>Konto-ID<input value={params.get('accountId') ?? ''} onChange={(event) => change('accountId', event.target.value)} maxLength={128} /></label>
      <label>Objekt-ID<input value={params.get('objectId') ?? ''} onChange={event => change('objectId', event.target.value)} maxLength={128} /></label>
      {!['incidents', 'reconciliations'].includes(kind) && <label>Intent-ID<input value={params.get('intentId') ?? ''} onChange={(event) => change('intentId', event.target.value)} maxLength={64} /></label>}
      <label>Status<select value={params.get('status') ?? ''} onChange={(event) => change('status', event.target.value)}><option value="">Alle</option>{(page?.states ?? []).map((status: string) => <option key={status}>{status}</option>)}</select></label><button className="secondary-button" onClick={() => setParams(new URLSearchParams())}>Filter zurücksetzen</button></div>
    {error && <p role="alert">{error} Vorhandene Anzeige kann veraltet sein.</p>}
    {page ? <><p>{page.entries.length} Datensätze auf dieser Serverseite · beobachtet {new Date(page.observedAt).toLocaleString('de-DE')} · {page.hasMore ? 'weitere Seiten vorhanden' : 'Ende der Auswahl'}</p><EvidenceTable caption={LISTS[kind].title} rows={entries} columns={[["id", "Objekt / Trade"], ["accountId", "Konto"], ...LISTS[kind].columns.map(([key, label]) => [key, label] as [string, string])]} />
      <div className="flex gap-3"><button className="secondary-button" disabled={!params.has('cursor')} onClick={() => change('cursor', '')}>Erste Seite</button><button className="secondary-button" disabled={!page.hasMore} onClick={() => { const next = new URLSearchParams(params); next.set('cursor', page.nextCursor); setParams(next); }}>Nächste Seite</button></div></> : !error && <p><output>Liste wird geladen …</output></p>}
    <p>Order-ACK, Fill und bestätigter Schutz sind getrennte Nachweise. Der Positionsstop allein belegt keine Stopdeckung. Unbekannte Orderausgänge werden nicht automatisch erneut gesendet.</p>
  </div>;
}
