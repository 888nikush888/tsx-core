import { useCallback, useState } from 'react';
import { jsonRequest, mutateAndObserve } from '@/lib/api';
import { Link, useSearchParams } from '@/lib/navigation';
import { usePoll } from '@/shared/api/use-poll';
import { useOperatorReadOnly } from '@/shared/api/operator-session';
import { EvidenceFields, EvidenceTable } from '@/shared/components/evidence';
import { ChangeReview } from '@/shared/components/change-review';
import { MoneyAmount } from '@/app/workflow/money-amount';
import { time } from '@/shared/components/operator-primitives';
import { useConfirmationDialog } from '@/components/confirmation-dialog';
import { resourceUrl } from '@/features/workflows/workflow-library';

const tier = (value: unknown) => typeof value === 'number' ? `Stufe ${value + 1}` : 'nicht festgehalten';
const href = (params: Record<string, string>) => `/risk/adaptive?${new URLSearchParams(params)}`;
function useAdaptive(query: string) {
  const [state, setState] = useState<any>(null); const [error, setError] = useState('');
  const load = useCallback((signal?: AbortSignal) => jsonRequest(`/api/trading/risk/adaptive?${query}`, { signal }), [query]);
  usePoll(load, value => { setState({ query, value }); setError(''); }, failure => setError(failure.message));
  return { data: state?.query === query ? state.value : null, error, load };
}
function SourceEvidence({ id, channelId }: Readonly<{ id: string; channelId?: string }>) {
  const [cursor, setCursor] = useState(''); const query = new URLSearchParams({ kind: 'sources', id });
  if (channelId) { query.set('channelId', channelId); } if (cursor) { query.set('cursor', cursor); }
  const { data, error } = useAdaptive(query.toString());
  return <section className="space-y-3"><h3>Originale Datenbasis</h3>{error && <p role="alert">{error}</p>}
    {data && <>{data.sourceAvailable ? <><p>Originalhash geprüft: {data.sourceHash}. Das prüft die gespeicherte Herkunft; nachträgliche Änderungen an Geldereignissen werden von der Engine gesondert geprüft.</p>
      <ChangeReview label="Kapitalbasis und Auswertungszeitraum" after={{ capital: data.capital, scope: data.scope }} />
      <EvidenceTable caption={`Ursprüngliche Positionsquellen (${data.sourceCount})`} columns={[['intentId', 'Trade'], ['closedAt', 'Abgeschlossen'], ['projectionHash', 'Abrechnungshash'], ['valuationHash', 'Bewertungshash']]} rows={data.entries.map((row: any) => ({ ...row, intentId: <Link to={`/trading/trades/${encodeURIComponent(row.intentId)}`}>{row.intentId}</Link>, closedAt: time(row.closedAt) }))} />
      <div className="flex gap-3"><button className="secondary-button" disabled={!cursor} onClick={() => setCursor('')}>Erste Quellen</button><button className="secondary-button" disabled={!data.hasMore} onClick={() => setCursor(data.nextCursor)}>Weitere Quellen</button></div></> : <p>{data.reason}</p>}</>}
  </section>;
}
function ActivePolicyPaths({ stateKey }: Readonly<{ stateKey: string }>) {
  const [cursor, setCursor] = useState(''); const query = new URLSearchParams({ kind: 'paths', stateKey }); if (cursor) query.set('cursor', cursor);
  const { data, error } = useAdaptive(query.toString());
  return <section className="space-y-4"><h3>Aktive Pfade und gespeicherte Konfiguration</h3>{error && <p role="alert">{error} Nach einer Graphänderung die erste Seite neu laden.</p>}
    {data?.entries.map((row: any) => <article key={row.id} className="border-t pt-3"><Link to={`/workflows/paths/${encodeURIComponent(row.id)}`}>Pfad {row.id}</Link>
      <p>{row.matchesStoredState ? 'Die aktive Policy stimmt mit dem gespeicherten Runtimehash überein.' : 'Die aktive Policy unterscheidet sich vom gespeicherten Runtimehash. Die Anzeige setzt den Runtimezustand nicht zurück.'}</p>
      <Link to={resourceUrl(row.resource)}>Policy {row.resource.name} · Version {row.resource.version} öffnen und neuen Entwurf bearbeiten</Link>
      <EvidenceFields fields={[['Modus', row.resource.configuration.mode], ['Startstufe', tier(row.resource.configuration.startingTier)], ['Feste Stufe', tier(row.resource.configuration.lockedTier)], ['Manuell gesperrt', row.resource.configuration.manuallyBlocked], ['Aktiv', row.resource.configuration.enabled], ['Policyhash', row.policySha256]]} />
      <ChangeReview label="Parameter dieser aktiven Policyversion" after={row.resource.configuration} /></article>)}
    {data && !data.entries.length && <p>Kein aktuell aktiver Pfad mit dieser Kanal-/Konto-/Ressourcenbindung. Der gespeicherte Zustand bleibt als Historie sichtbar.</p>}
    <div className="flex gap-3"><button className="secondary-button" onClick={() => setCursor('')}>Erste Pfade</button><button className="secondary-button" disabled={!data?.hasMore} onClick={() => setCursor(data.nextCursor)}>Weitere Pfade</button></div>
    <p>Fixed und Shadow verwenden das Strategie-Sizing. Automatic wählt die Stufe innerhalb der Strategiegrenze. Sperren bleiben separat. Stufen werden hier ab 1 angezeigt; das Entfernen einer festen Stufe speichert null.</p>
  </section>;
}
function EvaluationCard({ row, legacyChannel }: Readonly<{ row: any; legacyChannel?: string }>) {
  const [showSources, setShowSources] = useState(false);
  return <article className="operations-card space-y-4"><h2>Auswertung {row.id}</h2><p>{row.accountName} {row.mode} · {row.channelId} · {time(row.weekStartedAt)} bis {time(row.weekEndedAt)} · {row.closedTrades} abgeschlossene Trades</p>
    <EvidenceFields fields={[['Vorher', tier(row.previousTier)], ['Empfohlen', tier(row.recommendedTier)], ['Angewendet', tier(row.appliedTier)], ['Aktion', row.action], ['Grund', row.reason], ['Originaler Policyhash', row.policySha256], ['Legacy-Policyversion', row.policyVersion], ['Passt zum heutigen Runtimehash', row.matchesCurrentStatePolicy], ['Ausgewertet', time(row.createdAt)], ['Ungültig seit', time(row.invalidatedAt)], ['Invalidierungsgrund', row.invalidationReason], ['Ursprungshash', row.sourceHash]]} />
    {row.invalidatedAt != null && <p role="alert">Diese Auswertung ist ungültig geworden. Eine frühere Empfehlung ist keine aktuelle Freigabe.</p>}
    <dl className="grid sm:grid-cols-3 gap-4"><div><dt>Realisierter Betrag</dt><dd><MoneyAmount value={row.realizedPnlValue} amount={row.realizedPnl} currency={row.reportingCurrency} status={row.realizedPnlValue ? 'complete' : 'unresolved'} /></dd></div>
      <div><dt>Kapitalbasis</dt><dd>{row.startingEquity} {row.reportingCurrency ?? 'Währung unbekannt'}</dd></div>
      <div><dt>Rendite</dt><dd><MoneyAmount value={row.returnPercentValue} amount={row.returnPercent} currency="%" status={row.returnPercentValue ? 'complete' : 'unresolved'} /> {row.returnPercentReason}</dd></div></dl>
    <p>Die gespeicherte Auswertung besitzt einen Policyhash. Daraus wird keine bestimmte historische Versions-ID oder heutige Strategie erfunden.</p>
    <button className="secondary-button" aria-expanded={showSources} onClick={() => setShowSources(!showSources)}>Originale Datenbasis {showSources ? 'schließen' : 'öffnen'}</button>
    {showSources && <SourceEvidence id={row.id} channelId={legacyChannel} />}
  </article>;
}
function LegacyCard({ entry }: Readonly<{ entry: any }>) {
  const { policy, configuration } = entry; const readOnly = useOperatorReadOnly(); const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<any>(null); const [error, setError] = useState(''); const { confirm, confirmationDialog } = useConfirmationDialog();
  const copy = async () => {
    if (readOnly || busy) return;
    if (!await confirm({ title: 'Legacy-Policy als Entwurf übernehmen', description: `Kanal ${policy.channelId}, Policyversion ${policy.policyVersion}. Die angezeigten Werte werden mit demselben Migrationsvalidator kopiert. Eine bestehende Sperre bleibt als manuelle Sperre erhalten. Keine Aktivierung und keine Änderung bestehender Intents.`, confirmLabel: 'Geprüften Entwurf anlegen' })) return;
    setBusy(true); setError('');
    try { await mutateAndObserve(() => jsonRequest('/api/trading/risk/adaptive/copy-legacy', { method: 'POST', headers: { 'X-Destructive-Confirmation': 'copy-legacy-risk-policy' }, body: JSON.stringify({ channelId: policy.channelId, copyHash: entry.copyHash }) }), setReceipt, async () => undefined); }
    catch (error_) { setError(`Kopie nicht bestätigt: ${error_ instanceof Error ? error_.message : String(error_)}. Vor einer weiteren Aktion den gespeicherten Entwurf prüfen.`); }
    finally { setBusy(false); }
  };
  return <article className="operations-card space-y-3">{confirmationDialog}<h2>Legacy · Kanal {policy.channelId}</h2>
    <EvidenceFields fields={[['Modus', policy.mode], ['Aktuelle Stufe', tier(policy.currentTier)], ['Feste Stufe', tier(policy.lockedTier)], ['Gesperrt', policy.blocked], ['Sperrgrund', policy.blockReason], ['Version', policy.policyVersion], ['Geändert', time(policy.updatedAt)]]} />
    <ChangeReview label="Geprüfte Werte des neuen Workflowentwurfs" after={configuration} />
    <Link to={href({ kind: 'legacy-evaluations', channelId: policy.channelId })}>Historische Legacy-Auswertungen</Link>
    <div><button className="primary-button" disabled={readOnly || busy} onClick={() => void copy()}>Als Workflowentwurf übernehmen</button></div>
    {entry.copiedVersionId && <Link to={resourceUrl({ resourceId: entry.copiedResourceId, id: entry.copiedVersionId })}>Bereits gespeicherte Kopie prüfen</Link>}
    {receipt && <p><output>Entwurf {receipt.alreadyCopied ? 'bereits vorhanden' : 'gespeichert'}; nicht aktiviert. <Link to={resourceUrl(receipt.resource)}>Ressourcenentwurf öffnen</Link></output></p>}
    {error && <p role="alert">{error}</p>}
  </article>;
}
export function AdaptiveRiskPage() {
  const [params, setParams] = useSearchParams(); const key = params.toString(); const { data, error } = useAdaptive(key);
  const kind = params.get('kind') || 'states';
  const go = (cursor: string | null) => { const next = new URLSearchParams(params); if (cursor) { next.set('cursor', cursor); } else { next.delete('cursor'); } setParams(next); };
  return <section className="space-y-5"><h1>Adaptive Risikopolicen</h1>
    <nav className="flex flex-wrap gap-4"><Link to={href({ kind: 'states' })}>Runtimezustände</Link><Link to={href({ kind: 'evaluations' })}>Auswertungen</Link><Link to={href({ kind: 'legacy' })}>Legacy und Migration</Link><Link to="/workflows/resources?resourceKind=adaptive_risk">Alle Policyversionen</Link></nav>
    <p>Auswertung, aktuelle Konfiguration und ausgeführter Trade sind getrennte Belege. Änderungen erfolgen über neue Ressourcenentwürfe, Publikation und ausdrückliche Graphaktivierung.</p>
    {error && <p role="alert">{error} Vorhandene Daten können veraltet sein.</p>}
    {data ? <><p>{data.interpretation} Gelesen {time(data.observedAt)}.</p>
      {data.entries.map((row: any) => {
        if (kind === 'legacy') {
          return <LegacyCard key={row.policy.channelId} entry={row} />;
        }
        if (kind.includes('evaluations')) {
          return <EvaluationCard key={row.id} row={row} legacyChannel={kind === 'legacy-evaluations' ? params.get('channelId')! : undefined} />;
        }
        return <article key={row.stateKey} className="operations-card space-y-4"><h2>{row.accountName} · {row.mode} · {row.channelId}</h2>
          <EvidenceFields fields={[['Ressource', row.resourceId], ['Aktuelle Stufe', tier(row.currentTier)], ['Feste Stufe', tier(row.lockedTier)], ['Gesperrt', row.blocked], ['Sperrgrund', row.blockReason], ['Policyhash des Zustands', row.policySha256], ['Aktualisiert', time(row.updatedAt)]]} />
          <div className="flex flex-wrap gap-4"><Link to={href({ kind: 'states', stateKey: row.stateKey })}>Diesen Policyscope öffnen</Link><Link to={href({ kind: 'evaluations', stateKey: row.stateKey })}>Alle Auswertungen dieses Scopes</Link>{row.latestEvaluationId && <Link to={href({ kind: 'evaluations', id: row.latestEvaluationId })}>Letzte Auswertung dieser Policy</Link>}</div>
          {params.get('stateKey') && <ActivePolicyPaths stateKey={row.stateKey} />}</article>;
      })}
      {!data.entries.length && <p>Keine gespeicherten Einträge für diese Auswahl. Das bedeutet keine nachgewiesene erfolgreiche Auswertung.</p>}
      <div className="flex gap-3"><button className="secondary-button" disabled={!params.has('cursor')} onClick={() => go(null)}>Erste Seite</button><button className="secondary-button" disabled={!data.hasMore} onClick={() => go(data.nextCursor)}>Weitere Policyeinträge</button></div></>
      : !error && <p><output>Risikopolicen werden geladen …</output></p>}
  </section>;
}
