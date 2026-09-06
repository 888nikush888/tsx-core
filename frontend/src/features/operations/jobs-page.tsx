import { useCallback, useState } from 'react';
import { Link, useSearchParams } from '@/lib/navigation';
import { jsonRequest } from '@/lib/api';
import { usePoll } from '@/shared/api/use-poll';
import { EvidenceFields, EvidenceTable } from '@/shared/components/evidence';

export const JOB_STATES: Record<string, string> = { accepted: 'Dauerhaft angenommen', running: 'In Arbeit', 'awaiting-restart': 'Warte auf neuen Prozess', succeeded: 'Abschluss belegt', failed: 'Fehlgeschlagen – Teilwirkungen prüfen', unknown: 'Ergebnis unbekannt – keine automatische Wiederholung' };
export const jobPath = (id: string) => `/operations/jobs/${encodeURIComponent(id)}`;
export function JobLink({ id }: { id: string }) { return <Link className="underline break-all" to={jobPath(id)}>Auftrag {id} prüfen</Link>; }

function JobResult({ job }: { job: any }) {
  const result = job.result?.previous ?? job.result;
  if (!result) return null;
  if (job.kind === 'parser-test') return <section><h3>KI- und Validierungsnachweis</h3><EvidenceFields fields={[
    ['Bestätigte Stufen', result.stages?.join(' → ')], ['Verwendetes Modell', result.provenance?.model], ['Parserversion', result.provenance?.parserVersion], ['Prompthash', result.provenance?.promptSha256], ['Quellhash', result.preview?.sourceSha256], ['Vertragsversion', result.preview?.contractVersionId],
    ['Handelsausführung', result.tradeExecuted], ['Versandauftrag erzeugt', result.deliveryCreated], ['Tokenverbrauch am UTC-Tag', result.usage?.usedTokens], ['Offene Tokenreservierungen', result.usage?.reservedTokens],
  ]} /><h3>Redigiertes Parserergebnis</h3>{result.xmlTruncated && <p role="alert">Das Ergebnis überschreitet das Anzeigebudget und ist gekürzt. Dieser Ausschnitt ist kein vollständig kopierbares XML-Dokument.</p>}<pre className="whitespace-pre-wrap break-all text-sm">{result.xml}</pre></section>;
  if (job.kind === 'backup-drill') return <section><h3>Isolierter Probelauf</h3><EvidenceFields fields={[
    ['Artefakthash', result.artifactSha256], ['Durchgeführt', result.performedAt == null ? null : new Date(result.performedAt).toLocaleString('de-DE')], ['Handelsruntime deaktiviert', result.runtimeDisabled], ['Prozessisolation', result.isolation], ['Betriebssystem-Sandbox', result.osSandbox],
  ]} /><p>Prüft Wiederherstellung in einem temporären Kindprozess mit gesperrten Netzwerk-APIs. Dies ist keine Betriebssystem-Sandbox und kein Nachweis einer Provider-Abnahme.</p></section>;
  if (job.kind === 'backup-restore') return <EvidenceFields fields={[["Bestätigtes Artefakt", result.artifactName], ["Rollback-Dateien bewahrt", result.rollbackPreserved], ["Neuer Prozess beobachtet", job.result?.observedInstanceId]]} />;
  return null;
}

export function JobsPage({ id }: { id?: string }) {
  const [params, setParams] = useSearchParams(); const query = params.toString();
  const [value, setValue] = useState<any>(null); const [error, setError] = useState('');
  const context = id ?? query;
  const read = useCallback(async (signal: AbortSignal) => ({ context, payload: await jsonRequest(`/api/operations/jobs?${id ? `id=${encodeURIComponent(id)}` : query}`, { signal }) }), [id, query, context]);
  usePoll(read, data => { setValue(data); setError(''); }, reason => setError(reason.message), 3_000);
  const current = value?.context === context ? value.payload : null; const job = current?.job;
  const filter = (key: string, item: string) => setParams(previous => { if (item) previous.set(key, item); else previous.delete(key); previous.delete('cursor'); return previous; }, { replace: true });
  return <div className="operations-stack"><h1>{id ? 'Wartungsauftrag' : 'Wartung & Aufträge'}</h1><p>Ein angenommener Auftrag ist noch kein Abschluss. Nach Verbindungsabbruch nur den Status lesen. Unbekannte Ergebnisse werden nicht automatisch erneut ausgeführt.</p>
    {id && <Link to="/operations/jobs">Alle Aufträge</Link>}{error && <p role="alert">{error} · Letzte Anzeige möglicherweise veraltet; kein Abschlussbeleg.</p>}
    {!id && <section className="operations-card system-form"><label>Zustand<select value={params.get('state') ?? ''} onChange={event => filter('state', event.target.value)}><option value="">Alle</option>{Object.entries(JOB_STATES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><button onClick={() => setParams(new URLSearchParams())}>Filter zurücksetzen</button></section>}
    {job && <section className="operations-card"><h2>{JOB_STATES[job.state] ?? job.state}</h2><EvidenceFields fields={[
      ['Auftrag', job.id], ['Aktion', job.kind], ['Verantwortlich', job.actorId], ['Angenommen', new Date(job.acceptedAt).toLocaleString('de-DE')], ['Letzter Nachweis', new Date(job.updatedAt).toLocaleString('de-DE')], ['Teilschritt', job.stage], ['Fehler', job.error],
      ...Object.entries(job.scope ?? {}).map(([key, entry]) => [`Scope · ${key}`, String(entry)] as [string, string]),
    ]} /><p>Ein neuer Prozess belegt den Wiederanlauf. Betriebsbereitschaft, Kontoprüfung und Entry-Freigaben müssen danach separat im <Link to="/cockpit">Cockpit</Link> geprüft werden.</p>
      {job.result?.artifactName && <Link to={`/operations/backups/${encodeURIComponent(job.result.artifactName)}`}>Bestätigtes Artefakt prüfen</Link>}
      <JobResult job={job} />
      {job.result != null && <details><summary>Technische Prüfbelege</summary><pre className="whitespace-pre-wrap break-all text-sm">{JSON.stringify(job.result, null, 2)}</pre></details>}
    </section>}
    {current && !id && <><EvidenceTable caption={`Aufträge · Beobachtung ${new Date(current.statesObservedAt ?? current.observedAt).toLocaleString('de-DE')}`} rows={current.jobs.map((entry: any) => ({ ...entry, link: <JobLink id={entry.id} />, stateLabel: JOB_STATES[entry.state] ?? entry.state, time: new Date(entry.updatedAt).toLocaleString('de-DE') }))} columns={[["link", "Auftrag"], ["kind", "Aktion"], ["stateLabel", "Zustand"], ["time", "Letzter Nachweis"]]} />
      <p>Aufbewahrung: maximal 200 Aufträge; aktive Aufträge bleiben erhalten. Der Zustandsfilter verwendet den aktuellen Nachweis jeder Seite.</p><div className="system-actions"><button disabled={!params.has('cursor')} onClick={() => filter('cursor', '')}>Erste Seite</button><button disabled={!current.hasMore} onClick={() => setParams(previous => { previous.set('cursor', current.nextCursor); return previous; })}>Nächste Seite</button></div></>}
    {!current && <p role="status">Nachweis wird geladen …</p>}
  </div>;
}
