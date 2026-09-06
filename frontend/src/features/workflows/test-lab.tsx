import { useCallback, useState } from 'react';
import { jsonRequest } from '@/lib/api';
import { Link, useSearchParams } from '@/lib/navigation';
import { usePoll } from '@/shared/api/use-poll';
import { useDirtyGuard } from '@/shared/forms/use-dirty-guard';
import { useOperatorReadOnly } from '@/shared/api/operator-session';
import { EvidenceFields } from '@/shared/components/evidence';
import { JobLink } from '@/features/operations/jobs-page';
import { AI_LIMIT_LABELS } from '../../../../src/ui_contracts';

export function TestLab() {
  const readOnly = useOperatorReadOnly(); const [params, setParams] = useSearchParams();
  const mode = params.get('mode') || 'filter'; const pathId = params.get('pathId') || '';
  const [metadata, setMetadata] = useState<any>(null); const [preview, setPreview] = useState<any>(null);
  const [contracts, setContracts] = useState<any[]>([]); const [contractId, setContractId] = useState('');
  const [sourceText, setSourceText] = useState(''); const [xml, setXml] = useState(''); const [channelId, setChannelId] = useState('');
  const [consent, setConsent] = useState(false); const [busy, setBusy] = useState(false); const [jobId, setJobId] = useState('');
  const [error, setError] = useState(''); const [result, setResult] = useState<any>(null);
  useDirtyGuard(Boolean(sourceText || xml));
  const read = useCallback((signal: AbortSignal) => jsonRequest('/api/workflow/parser-test', { signal }), []);
  usePoll(read, setMetadata, reason => setError(reason.message), 10_000);
  const readContracts = useCallback((signal: AbortSignal) => mode === 'xml' ? jsonRequest('/api/trading', { signal }) : Promise.resolve(null), [mode]);
  usePoll(readContracts, value => { if (value) setContracts((value.signalContracts ?? []).flatMap((contract: any) => (contract.versions ?? []).filter((version: any) => version.status === 'published').map((version: any) => ({ ...version, name: contract.name })))); }, reason => setError(reason.message), 30_000);
  const invalidate = () => { setPreview(null); setConsent(false); setResult(null); };
  const send = async (endpoint: string, body: unknown, headers: Record<string, string> = {}) => jsonRequest(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const action = async (kind: 'filter' | 'xml' | 'preview' | 'run') => {
    if (readOnly || busy) return;
    setBusy(true); setError(''); setResult(null);
    try {
      if (kind === 'preview') { setPreview(await send('/api/workflow/parser-test/preview', { sourceText, pathId })); setConsent(false); }
      else if (kind === 'run') {
        if (!preview || !consent) return;
        const id = crypto.randomUUID(); setJobId(id);
        const response = await send('/api/workflow/parser-test', { sourceText, pathId, jobId: id, externalDataConsent: true, previewHash: preview.previewHash, previewObservedAt: preview.observedAt }, { 'X-Destructive-Confirmation': 'run-parser-test' });
        setResult({ accepted: Boolean(response.job), message: 'Nur der Auftrag ist angenommen. KI- und Validierungsergebnis im Auftragsverlauf prüfen.' }); setConsent(false);
      } else if (kind === 'filter') setResult(await send('/api/workflow/simulate', { channelId, text: sourceText, contentType: 'text' }));
      else {
        const contract = contracts.find(item => item.id === contractId); if (!contract) throw new Error('Veröffentlichte Vertragsversion auswählen.');
        setResult({ contractVersionId: contractId, groundingRequested: Boolean(sourceText.trim()), response: await send('/api/trading/signal-contracts/validate', { definition: contract.definition, xml, sourceText }) });
      }
    } catch (reason) { setError(`${reason instanceof Error ? reason.message : String(reason)}. Kein automatischer zweiter Aufruf. Bei unbekanntem KI-Ergebnis zuerst den Auftrag prüfen.`); }
    finally { setBusy(false); }
  };
  return <div className="operations-stack"><h1>Testlabor</h1><nav aria-label="Testarten" className="system-actions">{[['filter', '1 · Filter & Pfade'], ['xml', '2 · XML & Vertrag'], ['ai', '3 · KI-Parser']].map(([key, label]) => <button aria-pressed={mode === key} key={key} onClick={() => { invalidate(); setParams(previous => { previous.set('mode', key); return previous; }); }}>{label}</button>)}<Link to="/trading/paper">4 · Paper-Labor</Link></nav>
    <p>{mode === 'filter' ? 'Prüft Filter und Pfade der aktiven Revision. Führt keinen KI-Aufruf, keine Vertragsvalidierung und keine Order aus.' : mode === 'xml' ? 'Prüft die veröffentlichte Vertragsdefinition gegen XML. Grounding wird nur mit bereitgestelltem Quelltext geprüft. Keine Börsenaktion.' : 'Tatsächlicher kostenpflichtiger Provideraufruf mit XML- und Grounding-Prüfung. Globale Quoten, Reservierungen und konfigurierte Retry-Grenzen gelten. Erzeugt keine Signale, Intents, Orders oder Versandaufträge.'}</p>
    {error && <p role="alert">{error}</p>}{readOnly && <p>Tests erfordern Administratorrechte. Verbrauch und Einstellungen sind lesbar.</p>}
    <section className="operations-card system-form">{mode === 'filter' && <label>Kanal-ID<input value={channelId} onChange={event => { setChannelId(event.target.value); invalidate(); }} maxLength={128} /></label>}
      {mode === 'ai' && <label>Parserkontext<select value={pathId} onChange={event => { invalidate(); setParams(previous => { if (event.target.value) previous.set('pathId', event.target.value); else previous.delete('pathId'); return previous; }); }}><option value="">Globale Konfiguration / Standardvorlage</option>{metadata?.paths?.map((path: any) => <option key={path.id} value={path.id}>{path.channelId} → {path.accountId} · {path.id}</option>)}</select></label>}
      {mode === 'xml' && <><label>Veröffentlichte Vertragsversion<select value={contractId} onChange={event => { setContractId(event.target.value); invalidate(); }}><option value="">Auswählen</option>{contracts.map(contract => <option key={contract.id} value={contract.id}>{contract.name} · v{contract.version} · {contract.id}</option>)}</select></label><label>XML<textarea rows={8} value={xml} onChange={event => { setXml(event.target.value); invalidate(); }} maxLength={100_000} /></label></>}
      <label>Quelltext {mode === 'xml' ? '(optional für Grounding)' : ''}<textarea aria-label="Quelltext" rows={8} value={sourceText} onChange={event => { setSourceText(event.target.value); invalidate(); }} maxLength={metadata?.limits?.maxInputChars ?? 12_000} /></label><p>Quelltext bleibt außerhalb von URL und Browserhistorie. Im KI-Auftragsverlauf werden Hash und redigiertes Ergebnis gespeichert.</p>
      <button className="primary-button" disabled={busy || readOnly || (mode === 'xml' ? !xml || !contractId : !sourceText.trim() || mode === 'filter' && !channelId.trim())} onClick={() => void action(mode === 'ai' ? 'preview' : mode === 'xml' ? 'xml' : 'filter')}>{mode === 'ai' ? 'Provideraufruf vorbereiten' : 'Lokalen Test ausführen'}</button>
    </section>
    {mode === 'ai' && preview && <section className="operations-card system-form"><h2>Provideraufruf prüfen</h2><EvidenceFields fields={[
      ['Empfänger', preview.provider], ['Primärmodell', preview.models?.primaryModel], ['Primärmodellquelle', preview.modelOrigins?.primary], ['Fallbackmodell', preview.models?.fallbackModel], ['Datenumfang', `${preview.sourceChars} Zeichen / ${preview.sourceBytes} Bytes`], ['Quellhash', preview.sourceSha256], ['Prompthash', preview.promptSha256], ['Originalrevision', preview.workflowRevisionId], ['Schema', preview.schemaId], ['Vertrag', preview.contractVersionId], ['Gesamtzeitlimit', `${preview.totalTimeoutMs} ms`],
      ...Object.entries(preview.limits ?? {}).map(([key, value]) => [`${AI_LIMIT_LABELS[key as keyof typeof AI_LIMIT_LABELS]?.[0] ?? key} (global)`, `${value} ${AI_LIMIT_LABELS[key as keyof typeof AI_LIMIT_LABELS]?.[1] ?? ''}`] as [string, string]),
    ]} /><p>{preview.scope}</p>{!preview.externalDataPolicyAccepted && <p role="alert">Globale Zustimmung zur externen Datenverarbeitung fehlt. In den KI-Einstellungen prüfen.</p>}{!preview.providerConfigured && <p role="alert">Provider-Zugang ist nicht konfiguriert.</p>}
      <label><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />Ich stimme der Übermittlung dieses Quelltextes an OpenRouter und die genannten Modelle zu; der Test nutzt die globalen KI-Quoten.</label>
      <button className="danger-button" disabled={busy || readOnly || !consent || !preview.externalDataPolicyAccepted || !preview.providerConfigured} onClick={() => void action('run')}>KI-Test einmal beauftragen</button>
    </section>}
    {jobId && <JobLink id={jobId} />}{result && <section className="operations-card"><h2>{mode === 'ai' ? 'Auftragsannahme' : 'Lokales Prüfergebnis'}</h2><p>{mode === 'ai' ? result.message : 'Nur die oben beschriebene Teststufe wurde ausgeführt. Daraus folgt keine Handelsfreigabe.'}</p><pre className="whitespace-pre-wrap break-all text-sm">{JSON.stringify(result, null, 2)}</pre></section>}
    {metadata && <section className="operations-card"><h2>KI-Verbrauch & Queue</h2><EvidenceFields fields={[
      ['Quotentag', `${metadata.usageDay} (UTC)`], ['Anfragen', metadata.usage?.requestCount], ['Verwendete Tokens', metadata.usage?.usedTokens], ['Offene Tokenreservierungen', metadata.usage?.reservedTokens],
      ['Queue läuft', metadata.queue?.running], ['Queue wartet', metadata.queue?.queued], ['Concurrency aktiv', metadata.queue?.maxConcurrency], ['Queue pausiert', metadata.queue?.paused], ['Beobachtung', new Date(metadata.observedAt).toLocaleString('de-DE')],
    ]} /><Link to="/operations/settings">KI-Limits und globale Modelle bearbeiten</Link></section>}
  </div>;
}
