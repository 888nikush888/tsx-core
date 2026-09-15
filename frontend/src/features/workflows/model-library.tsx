import { useCallback, useState } from 'react';
import { jsonRequest, mutateAndObserve } from '@/lib/api';
import { Link, useSearchParams } from '@/lib/navigation';
import { usePoll } from '@/shared/api/use-poll';
import { useOperatorReadOnly } from '@/shared/api/operator-session';
import { EvidenceFields, EvidenceTable } from '@/shared/components/evidence';
import { ChangeReview } from '@/shared/components/change-review';
import { useConfirmationDialog } from '@/components/confirmation-dialog';
import { time } from '@/shared/components/operator-primitives';
import { resourceUrl } from './workflow-library';

type Kind = 'strategy' | 'schema' | 'contract';
const titles = { strategy: 'Strategien', schema: 'Schemaprofile', contract: 'Signalverträge' };
const modelUrl = (kind: Kind, id: string) => `/workflows/models/${kind}/${encodeURIComponent(id)}`;

export function ModelLibrary({ kind, id }: Readonly<{ kind: Kind; id?: string }>) {
  const [params, setParams] = useSearchParams(); const [data, setData] = useState<any>(null); const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<any>(null); const [busy, setBusy] = useState(false); const readOnly = useOperatorReadOnly();
  const { confirm, confirmationDialog } = useConfirmationDialog();
  const query = new URLSearchParams(params); query.set('kind', kind); if (id) { query.set('id', id); } else { query.delete('id'); } const key = query.toString();
  const load = useCallback((signal?: AbortSignal) => jsonRequest(`/api/workflow/models?${key}`, { signal }), [key]);
  usePoll(load, value => { setData(value); setError(''); }, failure => setError(failure.message));
  const command = async (action: string) => {
    if (busy || readOnly || !data?.reviewHash) return;
    const saved = { id, kind, action, reviewHash: data.reviewHash };
    const descriptions: Record<string, string> = {
      attach: 'Die genaue gespeicherte Modellversion wird als neuer Ressourcenentwurf verknüpft. Anschließend im gemeinsamen Bausteineditor bearbeiten oder mit Modellabhängigkeit publizieren. Keine Graphaktivierung.',
      publish: 'Diese genaue Definition wird publiziert und damit unveränderlich. Ressourcenpublikation und Graphaktivierung bleiben separate Schritte.',
      archive: 'Dieses Modell wird archiviert. Der Server prüft aktive Referenzen; gespeicherte Handelspläne bleiben erhalten.',
      delete: 'Dieses Modell wird dauerhaft gelöscht. Alle bestehenden Referenzsperren gelten. Nach einem unbekannten Ergebnis erst den Objektstand prüfen.',
      enable: 'Dieses Schemaprofil wird für zulässige neue Verwendungen aktiviert. Aktive Referenzen und Vertragsgültigkeit werden serverseitig geprüft.',
      disable: 'Dieses Schemaprofil wird deaktiviert. Aktive Verwendungen können die Änderung blockieren.',
    };
    if (!await confirm({ title: `Modellaktion: ${action}`, description: `${data.model.name} · ${id}. ${descriptions[action]}`,
      confirmLabel: 'Geprüfte Aktion ausführen', destructive: ['delete', 'archive', 'disable'].includes(action), confirmationText: action === 'delete' ? 'MODELL LÖSCHEN' : undefined })) return;
    setBusy(true); setError(''); setReceipt(null);
    try {
      const result = await mutateAndObserve(() => jsonRequest('/api/workflow/models', { method: 'POST', headers: { 'X-Destructive-Confirmation': 'mutate-workflow-model' }, body: JSON.stringify(saved) }), setReceipt,
        async () => setData(await load()));
      if (result.refreshError) setError(`Aktion bestätigt; Objektstand konnte nicht nachgeladen werden: ${result.refreshError}`);
    } catch (error_) { setError(`Aktion nicht bestätigt: ${error_ instanceof Error ? error_.message : String(error_)}. Keine automatische Wiederholung.`); }
    finally { setBusy(false); }
  };
  const modelContent = () => {
    if (!data) {
      return !error && <p><output>Modelle werden geladen …</output></p>;
    }
    if (id) {
      return <>
        <h2>{data.model.name} · {id}</h2><p>{data.effect}</p>
        <EvidenceFields fields={[["Zustand", data.model.status ?? (data.model.enabled ? 'enabled' : 'disabled')], ["Beobachtet", time(data.observedAt)], ["Prüfhash", data.reviewHash], ["Ressourcenreferenzen", data.resourceCount], ["Aktive Referenzen", data.activeReferenceCount], ["Aktive Revision", data.activeRevisionId]]} />
        <ChangeReview label="Gespeicherte Modelldefinition" after={data.model} />
        <div className="flex flex-wrap gap-3"><button className="primary-button" disabled={readOnly || busy || data.model.status === 'archived'} onClick={() => { command('attach'); }}>Als Ressourcenentwurf übernehmen</button>
          {kind !== 'schema' && data.model.status === 'draft' && <button className="secondary-button" disabled={readOnly || busy} onClick={() => { command('publish'); }}>Modell publizieren</button>}
          {kind !== 'schema' && data.model.status === 'published' && <button className="secondary-button" disabled={readOnly || busy || data.activeReferenceCount > 0} onClick={() => { command('archive'); }}>Modell archivieren</button>}
          {kind === 'schema' && <button className="secondary-button" disabled={readOnly || busy || data.activeReferenceCount > 0} onClick={() => { command(data.model.enabled ? 'disable' : 'enable'); }}>{data.model.enabled ? 'Profil deaktivieren' : 'Profil aktivieren'}</button>}
          <button className="secondary-button" disabled={readOnly || busy || data.resourceCount > 0} onClick={() => { command('delete'); }}>Modell löschen</button></div>
        {readOnly && <p>Viewer können Modelle und Referenzen lesen; Änderungen benötigen die Adminrolle.</p>}
        <EvidenceTable caption={`Ressourcen mit dieser Modellversion (${data.resources.length} von ${data.resourceCount})`} columns={[["name", "Ressource öffnen"], ["status", "Status"]]} rows={data.resources.map((resource: any) => ({ ...resource, name: <Link to={resourceUrl(resource)}>{resource.name} v{resource.version}</Link> }))} />
        {data.resourceCount > data.resources.length && <p>Weitere Referenzen sind in der Ressourcenbibliothek über die Bausteinart erreichbar.</p>}
      </>;
    }
    return <><p>Beobachtet {time(data.observedAt)} · {data.hasMore ? 'Weitere Seiten vorhanden' : 'Ende der Auswahl'}</p>
      <EvidenceTable caption={titles[kind]} columns={[["name", "Modell öffnen"], ["id", "ID"], ["status", "Status"], ["createdAt", "Erstellt"]]} rows={data.entries.map((model: any) => ({ ...model, name: <Link to={modelUrl(kind, model.id)}>{model.name}</Link>, createdAt: time(model.createdAt) }))} />
      <div className="flex gap-3"><button className="secondary-button" disabled={!params.has('cursor')} onClick={() => setParams(new URLSearchParams())}>Erste Seite</button><button className="secondary-button" disabled={!data.hasMore} onClick={() => setParams(new URLSearchParams({ cursor: data.nextCursor }))}>Nächste Seite</button></div>
      <Link to="/workflows/builder">Neues Modell im Bausteineditor anlegen</Link></>;
  };
  return <section className="space-y-5">{confirmationDialog}<h1>Modellbibliothek · {titles[kind]}</h1>
    <nav aria-label="Modellarten" className="flex flex-wrap gap-4">{Object.entries(titles).map(([value, label]) => <Link key={value} to={`/workflows/models/${value}`}>{label}</Link>)}<Link to="/workflows/resources">Ressourcenbibliothek</Link></nav>
    <p>Hier bleiben Modelle auch nach einem teilweise erfolgreichen Speichervorgang auffindbar. Neue Definitionen und fachliche Änderungen erfolgen im gemeinsamen Bausteineditor. Schemaprofile besitzen einen Aktivschalter; Strategie- und Vertragsversionen einen Publikationsstatus.</p>
    {error && <p role="alert">{error} Vorhandene Daten können veraltet sein.</p>}
    {receipt && <output className="block"><span className="block">Modellaktion {receipt.action} bestätigt. Keine Graphaktivierung oder Handelsausführung.</span>{receipt.resource && <Link to={resourceUrl(receipt.resource)}>Gespeicherten Ressourcenentwurf öffnen</Link>}</output>}
    {modelContent()}
  </section>;
}
