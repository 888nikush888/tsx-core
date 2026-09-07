import { listEntries } from "@/shared/list-entries";
import { useCallback, useState } from 'react';
import { jsonRequest, mutateAndObserve } from '@/lib/api';
import { Link, useSearchParams } from '@/lib/navigation';
import { usePoll } from '@/shared/api/use-poll';
import { useOperatorReadOnly } from '@/shared/api/operator-session';
import { EvidenceFields, EvidenceTable } from '@/shared/components/evidence';
import { ChangeReview } from '@/shared/components/change-review';
import { time } from '@/shared/components/operator-primitives';
import { useConfirmationDialog } from '@/components/confirmation-dialog';
import { ResourceEditor } from '@/app/workflow/resource-editor';
import { KIND_META, WORKFLOW_KINDS, type WorkflowKind, type WorkflowResource, type TradingSnapshot } from '@/app/workflow/types';

type Kind = 'resources' | 'paths' | 'revisions';
export const resourceUrl = (resource: { resourceId: string; id: string }) => `/workflows/resources/${encodeURIComponent(resource.resourceId)}/versions/${encodeURIComponent(resource.id)}`;
const TITLES: Record<Kind, string> = { resources: 'Ressourcenbibliothek', paths: 'Ausführungspfade', revisions: 'Workflowrevisionen' };

export function WorkflowLibrary({ kind, resourceId }: Readonly<{ kind: Kind; resourceId?: string }>) {
  const [params, setParams] = useSearchParams(); const [state, setState] = useState<any>(null); const [error, setError] = useState('');
  const query = new URLSearchParams(params); query.set('kind', kind); if (resourceId) { query.set('resourceId', resourceId); } const key = query.toString();
  const load = useCallback((signal: AbortSignal) => jsonRequest(`/api/workflow/objects?${key}`, { signal }), [key]);
  usePoll(load, value => { setState({ key, value }); setError(''); }, failure => setError(failure.message));
  const page = state?.key === key ? state.value : null;
  const change = (name: string, value: string) => { const next = new URLSearchParams(params); next.delete('cursor'); if (value) { next.set(name, value); } else { next.delete(name); } setParams(next); };
  const rows = (page?.entries ?? []).map((entry: any) => {
    const workflowEntryTitle = () => {
      if (kind === 'resources') {
        return `${entry.name} · v${entry.version}`;
      }
      if (kind === 'revisions') {
        return `Revision ${entry.revision}`;
      }
      return entry.id;
    };
    return (({ ...entry,
      id: <Link to={kind === 'resources' ? resourceUrl(entry) : `/workflows/${kind}/${encodeURIComponent(entry.id)}`}>{workflowEntryTitle()}</Link>,
      kind: KIND_META[entry.kind as WorkflowKind]?.short ?? entry.kind, createdAt: time(entry.createdAt), enabled: entry.enabled === 1,
      accountId: entry.accountId ? <Link to={`/trading/accounts/${encodeURIComponent(entry.accountId)}`}>{entry.accountId}</Link> : null }));
  });
  const workflowColumns = (): Array<[string, string]> => {
    if (kind === 'resources') {
      return [['kind', 'Bausteinart'], ['status', 'Zustand'], ['editRevision', 'Entwurfsstand']];
    }
    if (kind === 'paths') {
      return [['channelId', 'Kanal'], ['accountId', 'Konto'], ['fallbackRank', 'Fallbackrang (0 = primär)'], ['enabled', 'In dieser Revision aktiviert']];
    }
    return [['status', 'Zustand'], ['createdBy', 'Erstellt von']];
  };
  const columns: Array<[string, string]> = workflowColumns();
  return <section className="space-y-4"><h1>{TITLES[kind]}</h1>{resourceId && <p>Alle Versionen der Ressource {resourceId}</p>}
    <div className="flex flex-wrap gap-4">{kind === 'resources' && <label>Bausteinart<select className="block border bg-background p-2" value={params.get('resourceKind') ?? ''} onChange={event => change('resourceKind', event.target.value)}><option value="">Alle 13 Arten</option>{WORKFLOW_KINDS.map(kind => <option key={kind} value={kind}>{KIND_META[kind].short}</option>)}</select></label>}
      {kind !== 'paths' && <label>Versionsstatus<select className="block border bg-background p-2" value={params.get('status') ?? ''} onChange={event => change('status', event.target.value)}><option value="">Alle</option>{(kind === 'resources' ? ['draft', 'published', 'archived'] : ['active', 'archived']).map(status => <option key={status}>{status}</option>)}</select></label>}
      {kind === 'paths' && <><label>Revision-ID<input className="block border bg-background p-2" maxLength={128} value={params.get('revisionId') ?? ''} onChange={event => change('revisionId', event.target.value)} /></label><label><input type="checkbox" checked={params.get('active') !== 'false'} onChange={event => change('active', event.target.checked ? '' : 'false')} />Nur aktive Revision (ohne ausgewählte Revision-ID)</label></>}
      <button className="secondary-button" onClick={() => setParams(new URLSearchParams())}>Filter zurücksetzen</button></div>
    {error && <p role="alert">{error} · Angezeigte Daten können veraltet sein.</p>}
    {page ? <><p>Beobachtet {time(page.observedAt)} · {page.hasMore ? 'Weitere Serverseiten vorhanden' : 'Ende der Auswahl'}</p><EvidenceTable caption={TITLES[kind]} rows={rows} columns={[["id", "Objekt öffnen"], ...columns, ["createdAt", "Erstellt"]]} />
      <div className="flex gap-3"><button className="secondary-button" disabled={!params.has('cursor')} onClick={() => change('cursor', '')}>Erste Seite</button><button className="secondary-button" disabled={!page.hasMore} onClick={() => { const next = new URLSearchParams(params); next.set('cursor', page.nextCursor); setParams(next); }}>Nächste Seite</button></div></> : !error && <p><output>Bibliothek wird geladen …</output></p>}
    {kind === 'resources' && <Link to="/workflows/builder">Neuen Baustein im gemeinsamen Editor des Builders anlegen</Link>}
  </section>;
}

function workflowObjectTitle(kind: Kind, resource: WorkflowResource | undefined, data: any) {
  if (resource) return `${resource.name} · Version ${resource.version}`;
  return kind === 'paths' ? 'Originaler Ausführungspfad' : `Workflowrevision ${data.revision.revision}`;
}
function resourceArchiveLabel(resource: WorkflowResource) {
  return resource.status === 'draft' ? 'Entwurf löschen' : 'Version archivieren';
}

export function WorkflowObject({ kind, id, resourceId }: Readonly<{ kind: Kind; id: string; resourceId?: string }>) {
  const readOnly = useOperatorReadOnly(); const [data, setData] = useState<any>(null); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false); const [editing, setEditing] = useState(false); const [trading, setTrading] = useState<TradingSnapshot | null>(null);
  const [comparisonId, setComparisonId] = useState(''); const [comparison, setComparison] = useState<any>(null); const [savedResource, setSavedResource] = useState<WorkflowResource | null>(null);
  const { confirm, confirmationDialog } = useConfirmationDialog();
  const load = useCallback((signal?: AbortSignal) => jsonRequest(`/api/workflow/objects?kind=${kind}&id=${encodeURIComponent(id)}`, { signal }), [id, kind]);
  usePoll(load, value => { setData(value); setError(''); }, failure => setError(failure.message));
  const loadTrading = useCallback((signal: AbortSignal) => editing ? jsonRequest('/api/trading', { signal }) : Promise.resolve(null), [editing]);
  usePoll(loadTrading, value => { if (value) setTrading(value); }, failure => setError(`Editor-Kontext: ${failure.message}`));
  const resource: WorkflowResource | undefined = data?.resource;
  const command = async (operation: () => Promise<any>, label: string, accept?: (value: any) => void) => {
    if (readOnly || busy) { return null; } setBusy(true); setMessage('');
    try {
      const result = await mutateAndObserve(operation, value => { accept?.(value); setMessage(label); }, async () => setData(await load()));
      if (result.refreshError) setError(`Aktion bestätigt; Nachladen fehlgeschlagen: ${result.refreshError}`);
      return result.result;
    } catch (error_) { setError(`Aktion nicht bestätigt: ${error_ instanceof Error ? error_.message : String(error_)}. Keine automatische Wiederholung.`); return null; }
    finally { setBusy(false); }
  };
  const lifecycle = async (operation: 'publish' | 'archive' | 'delete', family = false) => {
    if (!resource) return;
    const operationDescription = operation === 'publish' ? `Wird unveränderlich; referenziertes Modell ${data.publication?.dependency?.id ?? 'keines'} wird gegebenenfalls mitpubliziert. Die Aktivierung im Signalweg folgt separat.` : 'Der Server prüft alle aktiven und historischen Referenzen. Eine Referenzsperre kann hier nicht umgangen werden.';
    const removal = operation === 'delete' || resource.status === 'draft' && operation === 'archive';
    const lifecycleConfirmLabel = () => {
      if (operation === 'publish') {
        return 'Publizieren';
      }
      if (removal) {
        return 'Löschen';
      }
      return 'Archivieren';
    };
    const lifecycleTitle = () => {
      if (operation === 'publish') {
        return 'Ressourcenversion publizieren';
      }
      if (removal) {
        return 'Ressource dauerhaft löschen';
      }
      return 'Ressource archivieren';
    };
    if (!await confirm({ title: lifecycleTitle(),
      description: `${resource.name} v${resource.version}${family ? ' · alle Versionen dieser Familie' : ''}. ${operationDescription}`,
      confirmationText: removal ? 'RESSOURCE LÖSCHEN' : undefined, confirmLabel: lifecycleConfirmLabel(), destructive: operation !== 'publish' })) return;
    const lifecycleSuccess = () => {
      if (operation === 'publish') {
        return 'Publikation bestätigt. Noch keine neue Graphaktivierung.';
      }
      if (removal) {
        return 'Löschung bestätigt; die alte Objektadresse kann nun 404 melden.';
      }
      return 'Archivierung bestätigt.';
    };
    await command(() => {
      const lifecycleConfirmation = () => {
        if (operation === 'publish') {
          return 'publish-workflow-dependencies';
        }
        if (operation === 'delete') {
          return 'delete-workflow-resource-permanently';
        }
        return 'delete-workflow-resource';
      };
      return (jsonRequest(operation === 'publish' ? '/api/workflow/resources/publish' : '/api/workflow/resources', { method: operation === 'publish' ? 'POST' : 'DELETE',
        headers: { 'X-Destructive-Confirmation': lifecycleConfirmation() },
        body: JSON.stringify(operation === 'publish' ? { id, baseEditRevision: resource.editRevision, publishDependencies: true, publicationHash: data.publication?.publicationHash } : { ...(family ? { resourceId: resource.resourceId } : { id }), operation }) }));
    },
      lifecycleSuccess(), result => { if (result.resource) setData((current: any) => ({ ...current, resource: result.resource })); });
  };
  const save = async (value: { name: string; description: string; configuration: Record<string, unknown>; baseEditRevision?: number }) => {
    if (!resource) return false;
    const result = await command(() => jsonRequest(resource.status === 'draft' ? '/api/workflow/resources/update' : '/api/workflow/resources', { method: 'POST', body: JSON.stringify({ ...value,
      ...(resource.status === 'draft' ? { id: resource.id } : { resourceId: resource.resourceId, kind: resource.kind }) }) }), 'Ressourcenentwurf gespeichert. Publikation und Graphaktivierung erfolgen separat.', result => setSavedResource(result.resource));
    return Boolean(result);
  };
  const restoreDraft = async () => {
    try {
      const [draft, active] = await Promise.all([jsonRequest('/api/workflow/drafts?id=operator'), jsonRequest('/api/workflow')]);
      if (!await confirm({ title: 'Historischen Graph als Entwurf übernehmen', description: `Revision ${data.revision.revision} ersetzt den gespeicherten Operatorentwurf ${draft.draft?.version ?? 'ohne Version'}. Die aktuelle Revision bleibt aktiv. Archivierte Quellen können vor einer späteren Aktivierung eine neue Version benötigen.`, confirmLabel: 'Entwurf übernehmen', destructive: true })) return;
      await command(() => jsonRequest('/api/workflow/drafts', { method: 'POST', body: JSON.stringify({ id: 'operator', baseVersion: draft.draft?.version ?? null, baseRevisionId: active.workflow?.id ?? null, graph: data.revision.graph }) }), 'Historischer Graph als neuer Operatorentwurf gespeichert. Im Builder vergleichen, publizieren und mit frischer Wirkungsprüfung aktivieren.');
    } catch (error_) { setError(String(error_)); }
  };
  if (!data) return <section><h1>Workflowobjekt</h1><p>{error ? <span role="alert">{error}</span> : <output>Objekt wird geladen …</output>}</p></section>;
  if (resourceId && resource?.resourceId !== resourceId) return <p role="alert">Diese Version gehört nicht zur angefragten Ressourcenfamilie.</p>;
  return <section className="space-y-5">{confirmationDialog}<Link to={`/workflows/${kind}`}>{TITLES[kind]}</Link><h1>{workflowObjectTitle(kind, resource, data)}</h1>
    {error && <p role="alert">{error}</p>}{message && <p><output>{message}</output></p>}{savedResource && <p><Link to={resourceUrl(savedResource)}>Gespeicherten Entwurf {savedResource.id} öffnen</Link></p>}
    <p>{data.effect}</p><p>Beobachtet {time(data.observedAt)}</p>
    {resource ? <><EvidenceFields fields={[["Ressource", resource.resourceId], ["Version-ID", resource.id], ["Zustand", resource.status], ["Entwurfsrevision", resource.editRevision], ["Konfigurationshash", resource.configurationSha256], ["Publiziert", time(resource.publishedAt)]]} />
      <Link to={`/workflows/resources/${encodeURIComponent(resource.resourceId)}`}>Alle Versionen dieser Ressource</Link>
      <ChangeReview after={resource.configuration} showAll label="Gespeicherte Parameter dieser Quelle" />
      {data.publication?.dependency && <ChangeReview after={data.publication.dependency} showAll label="Referenziertes Modell · Inhalt vor Publikation prüfen" />}
      <h2>Aktive Verwendungen</h2><ul>{data.activePaths.map((path: any) => <li key={path.id}><Link to={`/workflows/paths/${encodeURIComponent(path.id)}`}>{path.id}</Link> · Kanal {path.channelId}</li>)}</ul>{!data.activePaths.length && <p>In der beobachteten aktiven Revision nicht verwendet. Historische Referenzen werden bei Archivierung oder Löschung zusätzlich geprüft.</p>}
      <label>Vergleichsversion-ID<input className="block border bg-background p-2 w-full" maxLength={128} value={comparisonId} onChange={event => setComparisonId(event.target.value)} /></label>
      <button className="secondary-button" disabled={!comparisonId} onClick={() => void (async () => { try { const result = await jsonRequest(`/api/workflow/objects?kind=resources&id=${encodeURIComponent(comparisonId)}`); if (result.resource.resourceId !== resource.resourceId) { throw new Error('Vergleich erfordert dieselbe Ressourcenfamilie.'); } setComparison(result.resource); } catch (error_) { setError(String(error_)); } })()}>Versionen vergleichen</button>
      {comparison && <ChangeReview before={comparison.configuration} after={resource.configuration} label={`Vergleich v${comparison.version} → v${resource.version}`} />}
      {data.editingBlockedByRedaction && <p>Diese Quelle enthält redigierte Zugangsdaten. Bearbeiten/Kopieren ist gesperrt, damit Platzhalter keine gespeicherten Werte überschreiben. Zugangsdaten gehören in die separate Secretverwaltung.</p>}
      {WORKFLOW_KINDS.includes(resource.kind) ? <div className="flex flex-wrap gap-3"><button className="secondary-button" disabled={readOnly || busy || data.editingBlockedByRedaction} onClick={() => setEditing(true)}>{resource.status === 'draft' ? 'Entwurf bearbeiten' : 'Neue Version als Entwurf'}</button>
        {resource.status === 'draft' && <button className="primary-button" disabled={readOnly || busy} onClick={() => void lifecycle('publish')}>Version publizieren</button>}
        {resource.status !== 'archived' && <button className="secondary-button" disabled={readOnly || busy} onClick={() => void lifecycle('archive')}>{resourceArchiveLabel(resource)}</button>}
        <button className="secondary-button" disabled={readOnly || busy} onClick={() => void lifecycle('archive', true)}>Familie archivieren</button><button className="danger-button" disabled={readOnly || busy} onClick={() => void lifecycle('delete', true)}>Familie dauerhaft löschen</button></div> : <p>Unbekannte Bausteinart: Diese UI-Version bietet ausschließlich Lesezugriff.</p>}
      {editing && !trading && ['strategy', 'contract', 'schema', 'account'].includes(resource.kind) && <p><output>Modell- und Kontokontext für den Editor wird geladen …</output></p>}
      {editing && (trading || !['strategy', 'contract', 'schema', 'account'].includes(resource.kind)) && WORKFLOW_KINDS.includes(resource.kind) && <ResourceEditor draftOnly open kind={resource.kind} resource={resource} trading={trading} onSave={save} onClose={() => setEditing(false)} />}
    </> : <><EvidenceFields fields={[["Revision-ID", data.revision.id], ["Status", data.revision.status], ["Integrität geprüft", data.integrityVerified], ["Definition-Hash", data.revision.definitionSha256], ["Erstellt von", data.revision.createdBy], ["Erstellt", time(data.revision.createdAt)]]} />
      <Link to={`/workflows/paths?revisionId=${encodeURIComponent(data.revision.id)}&active=false`}>Alle Pfade dieser Revision</Link>
      {data.path && <><EvidenceFields fields={[["Pfad-ID", data.path.id], ["Kanal", data.path.channelId], ["Konto", <Link key="account" to={`/trading/accounts/${encodeURIComponent(data.path.accountId)}`}>{data.path.accountId}</Link>], ["Fallbackrang", data.path.fallbackRank]]} />
        <EvidenceTable caption="Wirksame Strategieparameter und Ursprung" rows={(data.parameterEffects ?? []).map((field: any) => {
          const strategyValue = () => {
            if (!field.strategyValuePresent) {
              return 'nicht gesetzt';
            }
            if (field.strategyValue === null) {
              return 'null';
            }
            if (typeof field.strategyValue === 'object') {
              return JSON.stringify(field.strategyValue);
            }
            return field.strategyValue;
          };
          const compiledValue = () => {
            if (field.value === null) {
              return 'null';
            }
            if (typeof field.value === 'object') {
              return JSON.stringify(field.value);
            }
            return field.value;
          };
          return (({ ...field,
            value: compiledValue(),
            strategyValue: strategyValue(),
            source: field.resourceId ? <Link to={resourceUrl({ resourceId: field.resourceId, id: field.sourceVersionId })}>{field.source} · {field.sourceVersionId}</Link> : `${field.source} · ${field.sourceVersionId ?? 'unbekannte Version'}` }));
        })}
          columns={[["field", "Parameter"], ["value", "Kompilierter Wert"], ["unit", "Einheit"], ["source", "Quelle"], ["strategyValue", "Strategiewert vor Override"], ["overridesStrategy", "Sizing überschreibt Strategie"]]} />
        <p>Diese Parameter gelten für Intents dieses Pfads. Signalhebel, adaptive Risikostufe und Markt-/FX-/Schutzbelege können den eigenen Tradeplan zusätzlich begrenzen. Die gespeicherte Strategie ist eine Quelle der kompilieren Konfiguration.</p>
        <details><summary>Vollständiger kompilierter Originalbeleg</summary><ChangeReview after={data.path.effectiveConfiguration} showAll label="Kompilierte wirksame Parameter dieses Pfads" /></details>
        <Link to={`/trading/journal?accountId=${encodeURIComponent(data.path.accountId)}&channelId=${encodeURIComponent(data.path.channelId)}`}>Trades dieses Kanals und Kontos · Originalpfad im Trade prüfen</Link></>}
      <EvidenceTable caption="Gepinnte Quellen" rows={data.sources.map((source: any) => ({ node: source.nodeId, kind: source.resource?.kind, resource: source.resource ? <Link to={resourceUrl(source.resource)}>{source.resource.name} · v{source.resource.version}</Link> : 'Originalquelle nicht verfügbar' }))} columns={[["node", "Knoten"], ["kind", "Art"], ["resource", "Version öffnen"]]} />
      {listEntries<string>(data.revision.warnings, warning => warning).map(({ item: warning, key }) => <p key={key}>{warning}</p>)}
      {kind === 'revisions' && <><ChangeReview after={data.revision.graph} showAll label="Originalgraph · unveränderlich" /><button className="secondary-button" disabled={readOnly || busy} onClick={() => void restoreDraft()}>Historischen Graph als Entwurf übernehmen</button><Link to="/workflows/builder">Entwurf im Builder prüfen</Link></>}
    </>}
  </section>;
}
