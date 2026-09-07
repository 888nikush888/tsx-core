import { useCallback, useState } from 'react';
import { jsonRequest } from '@/lib/api';
import { Link, useSearchParams } from '@/lib/navigation';
import { usePoll } from '@/shared/api/use-poll';
import { EvidenceTable } from '@/shared/components/evidence';
import { time } from '@/shared/components/operator-primitives';

const titles = { albums: 'Albumgruppen', members: 'Albummitglieder / Eingang', plans: 'Gepinnte Kanalpfade', signals: 'Parserergebnisse', attempts: 'Parserherkunft und Verbrauch', runs: 'Verarbeitungsläufe', branches: 'Pfadentscheidungen', fallbacks: 'Fallbackläufe', candidates: 'Fallbackkandidaten', intents: 'Erzeugte Intents', tasks: 'Outboxaufträge' };
const columns: Record<string, Array<[string, string]>> = {
  albums: [['albumId', 'Telegram-Album'], ['status', 'Status'], ['memberCount', 'Mitglieder'], ['readyAt', 'Fällig']],
  members: [['id', 'Eingang öffnen'], ['messageId', 'Telegram-ID'], ['status', 'Status'], ['workflowRevisionId', 'Originalrevision']],
  plans: [['executionPathId', 'Originalpfad'], ['accountId', 'Konto'], ['schemaId', 'Schema'], ['contractVersionId', 'Vertrag'], ['dedupeEnabled', 'Dedupe aktiv'], ['dedupeCooldownHours', 'Cooldown (Stunden)']],
  signals: [['id', 'Signal'], ['model', 'Modell'], ['parserVersion', 'Parser'], ['promptSha256', 'Prompthash'], ['workflowRevisionId', 'Originalrevision']],
  attempts: [['signalId', 'Signal'], ['model', 'Modell'], ['providerRequestId', 'Provideranfrage'], ['promptTokens', 'Eingabetokens'], ['completionTokens', 'Ausgabetokens'], ['promptSha256', 'Prompthash'], ['schemaName', 'Schema'], ['templateName', 'Vorlage']],
  runs: [['id', 'Lauf'], ['status', 'Status'], ['inputSha256', 'Eingabehash'], ['branchCount', 'Pfadentscheidungen'], ['reason', 'Grund']],
  branches: [['runId', 'Lauf'], ['routeGroupKey', 'Gruppe'], ['executionPathId', 'Originalpfad'], ['status', 'Entscheidung'], ['reason', 'Grund'], ['intentId', 'Trade']],
  fallbacks: [['id', 'Fallbacklauf'], ['routeGroupKey', 'Gruppe'], ['currentRank', 'Aktueller Rang'], ['status', 'Status'], ['intentId', 'Ausgewählter Trade'], ['reason', 'Stoppgrund']],
  candidates: [['fallbackRunId', 'Lauf'], ['rank', 'Rang'], ['accountId', 'Konto'], ['executionPathId', 'Originalpfad'], ['status', 'Status'], ['errorCode', 'Fehlercode'], ['reason', 'Grund'], ['intentId', 'Trade']],
  intents: [['id', 'Trade öffnen'], ['accountId', 'Konto'], ['symbol', 'Symbol'], ['side', 'Seite'], ['status', 'Intentstatus'], ['executionPathId', 'Originalpfad']],
  tasks: [['id', 'Outbox öffnen'], ['status', 'Versandstatus'], ['targetChatId', 'Gepinntes Ziel'], ['attempts', 'Versuche'], ['deliveryMode', 'Abschlussart'], ['acknowledged', 'Operatorquittierung'], ['reason', 'Grund']],
};
const OBJECT_ROUTES: Record<string, string> = { members: '/signals/messages/', intents: '/trading/trades/', signals: '/signals/processed/', tasks: '/signals/outbox?objectId=' };
function ingressObjectLink(kind: string, id: string) {
  const route = OBJECT_ROUTES[kind];
  return route ? <Link to={`${route}${encodeURIComponent(id)}`}>{id}</Link> : id;
}

export function IngressRelations({ id }: { id: string }) {
  const [params, setParams] = useSearchParams(); const kind = params.get('relation') || 'signals';
  const query = new URLSearchParams({ id, kind }); if (params.has('relationCursor')) query.set('cursor', params.get('relationCursor')!);
  const key = query.toString(); const [state, setState] = useState<any>(null); const [error, setError] = useState('');
  const read = useCallback((signal: AbortSignal) => jsonRequest(`/api/signals/ingress/relations?${key}`, { signal }), [key]);
  usePoll(read, value => { setState({ key, value }); setError(''); }, failure => setError(failure.message)); const data = state?.key === key ? state.value : null;
  const go = (relation: string, cursor?: string) => { const next = new URLSearchParams(params); next.set('relation', relation); if (cursor) next.set('relationCursor', cursor); else next.delete('relationCursor'); setParams(next); };
  const rows = data?.entries.map((row: any) => ({ ...row,
    id: ingressObjectLink(kind, row.id),
    workflowRevisionId: row.workflowRevisionId ? <Link to={`/workflows/revisions/${encodeURIComponent(row.workflowRevisionId)}`}>{row.workflowRevisionId}</Link> : null,
    executionPathId: row.executionPathId ? <Link to={`/workflows/paths/${encodeURIComponent(row.executionPathId)}`}>{row.executionPathId}</Link> : null,
    intentId: row.intentId ? <Link to={`/trading/trades/${encodeURIComponent(row.intentId)}`}>{row.intentId}</Link> : null,
    readyAt: time(row.readyAt), rank: typeof row.rank === 'number' ? row.rank + 1 : null, currentRank: typeof row.currentRank === 'number' ? row.currentRank + 1 : null,
    dedupeEnabled: row.dedupeEnabled == null ? null : row.dedupeEnabled === 1, acknowledged: row.acknowledged == null ? null : row.acknowledged === 1,
  }));
  return <section className="operations-card space-y-4"><h2>Verarbeitungsspur</h2>
    <label>Beziehung auswählen<select className="border bg-background p-2 block" value={kind} onChange={event => go(event.target.value)}>{Object.entries(titles).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>
    {error && <p role="alert">{error} Andere Beziehungen bleiben unabhängig lesbar.</p>}
    {data && <><p>{data.interpretation}</p><p>Albummitglieder bilden einen gemeinsamen Eingang. Ein ACK, eine Operatorquittierung oder ein erschöpfter Cursor beweist keinen Fill und keine Zustellung. Fehlende Dedupe-/Groundingentscheidungen sind unbekannt.</p>
      <EvidenceTable caption={titles[kind as keyof typeof titles] || kind} columns={columns[kind] || [['id', 'ID']]} rows={rows} />
      <div className="flex gap-3"><button className="secondary-button" disabled={!params.has('relationCursor')} onClick={() => go(kind)}>Erste Beziehungsseite</button><button className="secondary-button" disabled={!data.hasMore} onClick={() => go(kind, data.nextCursor)}>Weitere Beziehungen</button></div></>}
    {!data && !error && <p role="status">Beziehungen werden geladen …</p>}
  </section>;
}
