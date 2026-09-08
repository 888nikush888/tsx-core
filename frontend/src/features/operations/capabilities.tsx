import type { UiParameter } from "../../../../src/ui_contracts";
import { valueText } from "@/shared/value-text";
import { useCallback, useState } from 'react';
import { Link, useSearchParams } from '@/lib/navigation';
import { jsonRequest } from '@/lib/api';
import { usePoll } from '@/shared/api/use-poll';
import { EvidenceFields } from '@/shared/components/evidence';

const show = (value: unknown) => {
  if (value === null) {
    return 'null';
  }
  if (value === '') {
    return 'leer';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return valueText(value);
};
function ParameterEvidence({ entry }: Readonly<{ entry: UiParameter }>) {
  const editingContract = () => {
    if (entry.secret) {
      return 'Separater Secretcommand; gespeicherter Inhalt bleibt verborgen';
    }
    if (entry.editable) {
      return 'Im verlinkten Formular';
    }
    return 'Original, Deployment oder feste Sicherheitsgrenze';
  };
  return <EvidenceFields fields={[
          ['Typ und Einheit', `${entry.type}${entry.unit ? ` · ${entry.unit}` : ''}`], ['Grenzen', entry.constraints],
          ['Vorlage / Default', entry.defaultPresent ? show(entry.default) : 'Kein Wert vorgegeben; Pflichtfeld oder bedingter Validatorstandard.'],
          ['Leer / null / 0', entry.emptyMeaning], ['Quelle', entry.source], ['Scope', entry.scope], ['Wirkung', entry.effect],
    ['Bearbeitung', editingContract()],
          ['Neustart', entry.requiresRestart],
        ]} />;
}

interface CapabilityEntry {
  route: string; label: string; role: string; scope: string; effect: string;
  href: string; boundary?: string; inputVariants: string;
  currentBlockers: string[]; handler: string; contractTests: string[];
}
interface DirectoryPage<Entry> {
  contractVersion: number; total: number; entries: Entry[]; hasMore: boolean; nextCursor: string | null;
}
type DirectoryObservation =
  | { address: string; kind: 'parameters'; value: DirectoryPage<UiParameter> }
  | { address: string; kind: 'capabilities'; value: DirectoryPage<CapabilityEntry> };

function ParameterCard({ entry }: Readonly<{ entry: UiParameter }>) {
  return <article className="operations-card"><h2>{entry.path}</h2>
    <ParameterEvidence entry={entry} />
    <Link className="secondary-button" to={entry.href}>Fachansicht öffnen</Link>
    <details><summary>Vertragsnachweis</summary><p>{entry.validator}</p><p>{entry.consumer}</p></details>
  </article>;
}
function CapabilityCard({ entry }: Readonly<{ entry: CapabilityEntry }>) {
  return <article className="operations-card"><h2>{entry.label}</h2><p>{entry.route}</p>
    <EvidenceFields fields={[["Rolle", entry.role], ["Scope", entry.scope], ["Wirkung", entry.effect],
      ["Einordnung", entry.boundary ?? 'Bedienbare Operatorfähigkeit'], ["Varianten", entry.inputVariants]]} />
    {entry.currentBlockers?.length ? <p><output>{entry.currentBlockers.join(' ')}</output></p> : <p>Keine allgemeine Sperre beobachtet. Objektbezogene Prüfungen und Audit erfolgen erst am Befehl.</p>}
    <Link className="secondary-button" to={entry.href}>Fachansicht öffnen</Link>
    <details><summary>Vertragsnachweis</summary><p>{entry.handler}</p><p>{entry.contractTests?.join(' · ')}</p></details>
  </article>;
}
function DirectoryEntries({ observation }: Readonly<{ observation: DirectoryObservation }>) {
  return observation.kind === 'parameters'
    ? observation.value.entries.map(entry => <ParameterCard key={entry.path} entry={entry} />)
    : observation.value.entries.map(entry => <CapabilityCard key={entry.route} entry={entry} />);
}

export function CapabilitiesPage() {
  const [query, setQuery] = useSearchParams(); const parameters = query.get('view') === 'parameters';
  const [response, setResponse] = useState<DirectoryObservation | null>(null); const [error, setError] = useState('');
  const apiQuery = new URLSearchParams({ limit: '30' });
  const cursor = query.get('cursor'); if (cursor) apiQuery.set('cursor', cursor);
  const filter = parameters ? 'prefix' : 'area'; const filterValue = query.get(filter);
  if (filterValue) apiQuery.set(filter, filterValue);
  const address = `/api/ui/${parameters ? 'parameters' : 'capabilities'}?${apiQuery}`;
  const observation = response?.address === address ? response : null;
  const data = observation?.value;
  const read = useCallback(async (signal: AbortSignal): Promise<DirectoryObservation> => {
    const value = await jsonRequest(address, { signal });
    return parameters ? { address, kind: 'parameters', value } : { address, kind: 'capabilities', value };
  }, [address, parameters]);
  usePoll(read, value => { setResponse(value); setError(''); }, reason => setError(reason.message));
  const update = (key: string, value: string) => { setResponse(null); setQuery(current => {
      current.delete('cursor'); if (value) { current.set(key, value); } else { current.delete(key); } return current;
  }); };
  return <section className="operations-stack"><h1>Aktionen & Parameter</h1>
    <p>Dieses Verzeichnis erklärt Scope, Voraussetzungen und Wirkung. Den aktuellen Wert und die belegte Wirkung prüfen Sie in der jeweiligen Fachansicht. Der Server entscheidet bei jedem Befehl erneut über die Berechtigung.</p>
    <div className="builder-field-grid"><label>Verzeichnis<select value={parameters ? 'parameters' : 'capabilities'} onChange={event => {
      setResponse(null); setQuery(new URLSearchParams({ view: event.target.value }));
    }}><option value="capabilities">Verfügbare Aktionen</option><option value="parameters">Parameterverträge</option></select></label>
      {parameters ? <label>Parameterfamilie<select value={query.get('prefix') ?? ''} onChange={event => update('prefix', event.target.value)}>
        <option value="">Alle Familien</option>{['runtime', 'config', 'resource', 'strategy', 'schema', 'contract', 'account', 'paper', 'journal', 'graph', 'mcp', 'viewer', 'secrets', 'deployment'].map(name => <option key={name}>{name}</option>)}</select></label>
        : <label>Bereich<select value={query.get('area') ?? ''} onChange={event => update('area', event.target.value)}><option value="">Alle Bereiche</option>
          {[['cockpit', 'Cockpit'], ['trading', 'Trading'], ['workflows', 'Workflows'], ['signals', 'Signale'], ['risk', 'Risiko'], ['integrations', 'Integrationen'], ['operations', 'Betrieb'], ['recovery', 'Recovery']].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>}</div>
    {error && <p role="alert">Verzeichnis nicht aktuell bestätigt: {error}</p>}
    {!data && !error && <p><output>Verzeichnis wird geladen …</output></p>}
    {data && <><p>Vertrag {data.contractVersion} · {data.total} passende Einträge · {data.entries.length} auf dieser Seite</p>
      <DirectoryEntries observation={observation} />
      <div className="flex gap-3">{query.has('cursor') && <button className="secondary-button" onClick={() => update('cursor', '')}>Erste Seite</button>}
        {data.hasMore && <button className="primary-button" onClick={() => { setResponse(null); setQuery(current => { current.set('cursor', data.nextCursor); return current; }); }}>Weitere Einträge</button>}</div></>}
  </section>;
}
