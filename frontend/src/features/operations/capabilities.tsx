import { useCallback, useState } from 'react';
import { Link, useSearchParams } from '@/lib/navigation';
import { jsonRequest } from '@/lib/api';
import { usePoll } from '@/shared/api/use-poll';
import { EvidenceFields } from '@/shared/components/evidence';

const show = (value: unknown) => value === null ? 'null' : value === '' ? 'leer' : typeof value === 'object' ? JSON.stringify(value) : String(value);
export function CapabilitiesPage() {
  const [query, setQuery] = useSearchParams(); const parameters = query.get('view') === 'parameters';
  const [response, setData] = useState<any>(null); const [error, setError] = useState('');
  const apiQuery = new URLSearchParams({ limit: '30' });
  if (query.get('cursor')) apiQuery.set('cursor', query.get('cursor')!);
  const filter = parameters ? 'prefix' : 'area'; if (query.get(filter)) apiQuery.set(filter, query.get(filter)!);
  const address = '/api/ui/' + (parameters ? 'parameters' : 'capabilities') + '?' + apiQuery;
  const data = response?.address === address ? response.value : null;
  const read = useCallback((signal: AbortSignal) => jsonRequest(address, { signal }), [address]);
  usePoll(read, value => { setData({ address, value }); setError(''); }, reason => setError(reason.message));
  const update = (key: string, value: string) => { setData(null); setQuery(current => {
    current.delete('cursor'); if (value) current.set(key, value); else current.delete(key); return current;
  }); };
  return <section className="operations-stack"><h1>Aktionen & Parameter</h1>
    <p>Dieses Verzeichnis erklärt Scope, Voraussetzungen und Wirkung. Den aktuellen Wert und die belegte Wirkung prüfen Sie in der jeweiligen Fachansicht. Der Server entscheidet bei jedem Befehl erneut über die Berechtigung.</p>
    <div className="builder-field-grid"><label>Verzeichnis<select value={parameters ? 'parameters' : 'capabilities'} onChange={event => {
      setData(null); setQuery(new URLSearchParams({ view: event.target.value }));
    }}><option value="capabilities">Verfügbare Aktionen</option><option value="parameters">Parameterverträge</option></select></label>
      {parameters ? <label>Parameterfamilie<select value={query.get('prefix') ?? ''} onChange={event => update('prefix', event.target.value)}>
        <option value="">Alle Familien</option>{['runtime', 'config', 'resource', 'strategy', 'schema', 'contract', 'account', 'paper', 'journal', 'graph', 'mcp', 'viewer', 'secrets', 'deployment'].map(name => <option key={name}>{name}</option>)}</select></label>
        : <label>Bereich<select value={query.get('area') ?? ''} onChange={event => update('area', event.target.value)}><option value="">Alle Bereiche</option>
          {[['cockpit', 'Cockpit'], ['trading', 'Trading'], ['workflows', 'Workflows'], ['signals', 'Signale'], ['risk', 'Risiko'], ['integrations', 'Integrationen'], ['operations', 'Betrieb'], ['recovery', 'Recovery']].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>}</div>
    {error && <p role="alert">Verzeichnis nicht aktuell bestätigt: {error}</p>}
    {!data && !error && <p role="status">Verzeichnis wird geladen …</p>}
    {data && <><p>Vertrag {data.contractVersion} · {data.total} passende Einträge · {data.entries.length} auf dieser Seite</p>
      {data.entries.map((entry: any) => <article className="operations-card" key={parameters ? entry.path : entry.route}>
        <h2>{parameters ? entry.path : entry.label}</h2>
        {parameters ? <EvidenceFields fields={[
          ['Typ und Einheit', entry.type + (entry.unit ? ' · ' + entry.unit : '')], ['Grenzen', entry.constraints],
          ['Vorlage / Default', entry.defaultPresent ? show(entry.default) : 'Kein Wert vorgegeben; Pflichtfeld oder bedingter Validatorstandard.'],
          ['Leer / null / 0', entry.emptyMeaning], ['Quelle', entry.source], ['Scope', entry.scope], ['Wirkung', entry.effect],
          ['Bearbeitung', entry.secret ? 'Separater Secretcommand; gespeicherter Inhalt bleibt verborgen' : entry.editable ? 'Im verlinkten Formular' : 'Original, Deployment oder feste Sicherheitsgrenze'],
          ['Neustart', entry.requiresRestart],
        ]} /> : <><p>{entry.route}</p><EvidenceFields fields={[['Rolle', entry.role], ['Scope', entry.scope], ['Wirkung', entry.effect],
          ['Einordnung', entry.boundary ?? 'Bedienbare Operatorfähigkeit'], ['Varianten', entry.inputVariants]]} />
          {entry.currentBlockers?.length ? <p role="status">{entry.currentBlockers.join(' ')}</p> : <p>Keine allgemeine Sperre beobachtet. Objektbezogene Prüfungen und Audit erfolgen erst am Befehl.</p>}
        </>}
        <Link className="secondary-button" to={entry.href}>Fachansicht öffnen</Link>
        <details><summary>Vertragsnachweis</summary><p>{parameters ? entry.validator : entry.handler}</p><p>{parameters ? entry.consumer : entry.contractTests?.join(' · ')}</p></details>
      </article>)}
      <div className="flex gap-3">{query.has('cursor') && <button className="secondary-button" onClick={() => update('cursor', '')}>Erste Seite</button>}
        {data.hasMore && <button className="primary-button" onClick={() => { setData(null); setQuery(current => { current.set('cursor', data.nextCursor); return current; }); }}>Weitere Einträge</button>}</div></>}
  </section>;
}
