import { useCallback, useState } from 'react';
import { jsonRequest } from '@/lib/api';
import { Link, useSearchParams } from '@/lib/navigation';
import { usePoll } from '@/shared/api/use-poll';
import { useDirtyGuard } from '@/shared/forms/use-dirty-guard';
import { useOperatorReadOnly } from '@/shared/api/operator-session';
import { EvidenceFields } from '@/shared/components/evidence';
import { JobLink } from '@/features/operations/jobs-page';
import { AI_LIMIT_LABELS } from '../../../../src/ui_contracts';

type ParserPath = { id: string; channelId?: string | null; accountId?: string | null };
type ParserMetadata = {
  paths?: ParserPath[];
  limits?: { maxInputChars?: number | null } | null;
  usageDay?: string;
  usage?: { requestCount?: number | null; usedTokens?: number | null; reservedTokens?: number | null } | null;
  queue?: { running?: number | null; queued?: number | null; maxConcurrency?: number | null; paused?: boolean | null } | null;
  observedAt: number;
};
type ParserPreview = {
  previewHash: string;
  observedAt: number;
  provider?: string | null;
  models?: { primaryModel?: string | null; fallbackModel?: string | null } | null;
  modelOrigins?: { primary?: string | null; fallback?: string | null } | null;
  sourceChars?: number | null;
  sourceBytes?: number | null;
  sourceSha256?: string | null;
  promptSha256?: string | null;
  workflowRevisionId?: string | null;
  schemaId?: string | null;
  contractVersionId?: string | null;
  totalTimeoutMs?: number | null;
  limits?: Record<string, unknown> | null;
  externalDataPolicyAccepted?: boolean;
  providerConfigured?: boolean;
  scope?: string | null;
};
type ParserContract = { id: string; name?: string | null; version?: string | number | null; status?: string | null; definition?: unknown };
type ParserContractSource = { name?: string | null; versions?: ParserContract[] };
type ParserTestResult = Record<string, unknown> & { message?: string | null };

type TestAction = 'filter' | 'xml' | 'preview' | 'run';

function testActionFor(mode: string): TestAction {
  if (mode === 'ai') return 'preview';
  if (mode === 'xml') return 'xml';
  return 'filter';
}

function testRunDisabled(mode: string, busy: boolean, readOnly: boolean, xml: string, contractId: string, sourceText: string, channelId: string) {
  return busy || readOnly || (mode === 'xml' ? !xml || !contractId : !sourceText.trim() || mode === 'filter' && !channelId.trim());
}

function TestLabNav({ mode, onSelect }: Readonly<{ mode: string; onSelect: (key: string) => void }>) {
  return (
    <nav aria-label="Testarten" className="system-actions">{[['filter', '1 · Filter & Pfade'], ['xml', '2 · XML & Vertrag'], ['ai', '3 · KI-Parser']].map(([key, label]) => <button aria-pressed={mode === key} key={key} onClick={() => onSelect(key)}>{label}</button>)}<Link to="/trading/paper">4 · Paper-Labor</Link></nav>
  );
}

function TestFilterField({ channelId, setChannelId, invalidate }: Readonly<{ channelId: string; setChannelId: (value: string) => void; invalidate: () => void }>) {
  return (<><label>Kanal-ID<input value={channelId} onChange={event => { setChannelId(event.target.value); invalidate(); }} maxLength={128} /></label></>);
}

function TestAiField({ metadata, pathId, setParams, invalidate }: Readonly<{ metadata: ParserMetadata | null; pathId: string; setParams: (update: (previous: URLSearchParams) => URLSearchParams) => void; invalidate: () => void }>) {
  return (<><label>Parserkontext<select value={pathId} onChange={event => { invalidate(); setParams(previous => { if (event.target.value) { previous.set('pathId', event.target.value); } else { previous.delete('pathId'); } return previous; }); }}><option value="">Globale Konfiguration / Standardvorlage</option>{metadata?.paths?.map(path => <option key={path.id} value={path.id}>{path.channelId} → {path.accountId} · {path.id}</option>)}</select></label></>);
}

function TestXmlFields({ contractId, setContractId, contracts, xml, setXml, invalidate }: Readonly<{ contractId: string; setContractId: (value: string) => void; contracts: ParserContract[]; xml: string; setXml: (value: string) => void; invalidate: () => void }>) {
  return (<><label>Veröffentlichte Vertragsversion<select value={contractId} onChange={event => { setContractId(event.target.value); invalidate(); }}><option value="">Auswählen</option>{contracts.map(contract => <option key={contract.id} value={contract.id}>{contract.name} · v{contract.version} · {contract.id}</option>)}</select></label><label>XML<textarea rows={8} value={xml} onChange={event => { setXml(event.target.value); invalidate(); }} maxLength={100_000} /></label></>);
}

function TestSourceField({ mode, sourceText, setSourceText, metadata, invalidate }: Readonly<{ mode: string; sourceText: string; setSourceText: (value: string) => void; metadata: ParserMetadata | null; invalidate: () => void }>) {
  return (<>      <label>Quelltext {mode === 'xml' ? '(optional für Grounding)' : ''}<textarea aria-label="Quelltext" rows={8} value={sourceText} onChange={event => { setSourceText(event.target.value); invalidate(); }} maxLength={metadata?.limits?.maxInputChars ?? 12_000} /></label><p>Quelltext bleibt außerhalb von URL und Browserhistorie. Im KI-Auftragsverlauf werden Hash und redigiertes Ergebnis gespeichert.</p></>);
}

function TestRunButton({ mode, xml, contractId, sourceText, channelId, busy, readOnly, action }: Readonly<{
  mode: string; xml: string; contractId: string; sourceText: string; channelId: string; busy: boolean; readOnly: boolean; action: (kind: TestAction) => void | Promise<void>;
}>) {
  return (
      <button className="primary-button" disabled={testRunDisabled(mode, busy, readOnly, xml, contractId, sourceText, channelId)} onClick={() => { action(testActionFor(mode)); }}>{mode === 'ai' ? 'Provideraufruf vorbereiten' : 'Lokalen Test ausführen'}</button>
  );
}

function TestLabForm({ mode, metadata, pathId, setParams, channelId, setChannelId, contractId, setContractId, contracts, xml, setXml, sourceText, setSourceText, busy, readOnly, invalidate, action }: Readonly<{
  mode: string; metadata: ParserMetadata | null; pathId: string; setParams: (update: (previous: URLSearchParams) => URLSearchParams) => void;
  channelId: string; setChannelId: (value: string) => void; contractId: string; setContractId: (value: string) => void; contracts: ParserContract[];
  xml: string; setXml: (value: string) => void; sourceText: string; setSourceText: (value: string) => void; busy: boolean; readOnly: boolean;
  invalidate: () => void; action: (kind: TestAction) => void | Promise<void>;
}>) {
  return (
    <section className="operations-card system-form">
      {mode === 'filter' && <TestFilterField channelId={channelId} setChannelId={setChannelId} invalidate={invalidate} />}
      {mode === 'ai' && <TestAiField metadata={metadata} pathId={pathId} setParams={setParams} invalidate={invalidate} />}
      {mode === 'xml' && <TestXmlFields contractId={contractId} setContractId={setContractId} contracts={contracts} xml={xml} setXml={setXml} invalidate={invalidate} />}
      <TestSourceField mode={mode} sourceText={sourceText} setSourceText={setSourceText} metadata={metadata} invalidate={invalidate} />
      <TestRunButton mode={mode} xml={xml} contractId={contractId} sourceText={sourceText} channelId={channelId} busy={busy} readOnly={readOnly} action={action} />
    </section>
  );
}

function TestPreviewSection({ preview, consent, setConsent, busy, readOnly, action }: Readonly<{
  preview: ParserPreview | null; consent: boolean; setConsent: (value: boolean) => void; busy: boolean; readOnly: boolean; action: (kind: TestAction) => void | Promise<void>;
}>) {
  if (!preview) return null;
  return (
    <section className="operations-card system-form"><h2>Provideraufruf prüfen</h2><EvidenceFields fields={[
      ['Empfänger', preview.provider], ['Primärmodell', preview.models?.primaryModel], ['Primärmodellquelle', preview.modelOrigins?.primary], ['Fallbackmodell', preview.models?.fallbackModel], ['Datenumfang', `${preview.sourceChars} Zeichen / ${preview.sourceBytes} Bytes`], ['Quellhash', preview.sourceSha256], ['Prompthash', preview.promptSha256], ['Originalrevision', preview.workflowRevisionId], ['Schema', preview.schemaId], ['Vertrag', preview.contractVersionId], ['Gesamtzeitlimit', `${preview.totalTimeoutMs} ms`],
      ...Object.entries(preview.limits ?? {}).map(([key, value]) => [`${AI_LIMIT_LABELS[key as keyof typeof AI_LIMIT_LABELS]?.[0] ?? key} (global)`, `${value} ${AI_LIMIT_LABELS[key as keyof typeof AI_LIMIT_LABELS]?.[1] ?? ''}`] as [string, string]),
    ]} /><p>{preview.scope}</p>{!preview.externalDataPolicyAccepted && <p role="alert">Globale Zustimmung zur externen Datenverarbeitung fehlt. In den KI-Einstellungen prüfen.</p>}{!preview.providerConfigured && <p role="alert">Provider-Zugang ist nicht konfiguriert.</p>}
      <label><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />Ich stimme der Übermittlung dieses Quelltextes an OpenRouter und die genannten Modelle zu; der Test nutzt die globalen KI-Quoten.</label>
      <button className="danger-button" disabled={busy || readOnly || !consent || !preview.externalDataPolicyAccepted || !preview.providerConfigured} onClick={() => { action('run'); }}>KI-Test einmal beauftragen</button>
    </section>
  );
}

function TestResultSection({ jobId, result, mode }: Readonly<{ jobId: string; result: ParserTestResult | null; mode: string }>) {
  return (
    <>
    {jobId && <JobLink id={jobId} />}{result && <section className="operations-card"><h2>{mode === 'ai' ? 'Auftragsannahme' : 'Lokales Prüfergebnis'}</h2><p>{mode === 'ai' ? result.message : 'Nur die oben beschriebene Teststufe wurde ausgeführt. Daraus folgt keine Handelsfreigabe.'}</p><pre className="whitespace-pre-wrap break-all text-sm">{JSON.stringify(result, null, 2)}</pre></section>}
    </>
  );
}

function TestUsageSection({ metadata }: Readonly<{ metadata: ParserMetadata }>) {
  return (
    <section className="operations-card"><h2>KI-Verbrauch & Queue</h2><EvidenceFields fields={[
      ['Quotentag', `${metadata.usageDay} (UTC)`], ['Anfragen', metadata.usage?.requestCount], ['Verwendete Tokens', metadata.usage?.usedTokens], ['Offene Tokenreservierungen', metadata.usage?.reservedTokens],
      ['Queue läuft', metadata.queue?.running], ['Queue wartet', metadata.queue?.queued], ['Concurrency aktiv', metadata.queue?.maxConcurrency], ['Queue pausiert', metadata.queue?.paused], ['Beobachtung', new Date(metadata.observedAt).toLocaleString('de-DE')],
    ]} /><Link to="/operations/settings">KI-Limits und globale Modelle bearbeiten</Link></section>
  );
}

export function TestLab() {
  const readOnly = useOperatorReadOnly(); const [params, setParams] = useSearchParams();
  const mode = params.get('mode') || 'filter'; const pathId = params.get('pathId') || '';
  const [metadata, setMetadata] = useState<ParserMetadata | null>(null); const [preview, setPreview] = useState<ParserPreview | null>(null);
  const [contracts, setContracts] = useState<ParserContract[]>([]); const [contractId, setContractId] = useState('');
  const [sourceText, setSourceText] = useState(''); const [xml, setXml] = useState(''); const [channelId, setChannelId] = useState('');
  const [consent, setConsent] = useState(false); const [busy, setBusy] = useState(false); const [jobId, setJobId] = useState('');
  const [error, setError] = useState(''); const [result, setResult] = useState<ParserTestResult | null>(null);
  useDirtyGuard(Boolean(sourceText || xml));
  const read = useCallback((signal: AbortSignal) => jsonRequest('/api/workflow/parser-test', { signal }), []);
  usePoll(read, setMetadata, reason => setError(reason.message), 10_000);
  const readContracts = useCallback((signal: AbortSignal) => mode === 'xml' ? jsonRequest('/api/trading', { signal }) : Promise.resolve(null), [mode]);
  usePoll(readContracts, value => { if (value) setContracts(((value.signalContracts ?? []) as ParserContractSource[]).flatMap(contract => (contract.versions ?? []).filter(version => version.status === 'published').map(version => ({ ...version, name: contract.name })))); }, reason => setError(reason.message), 30_000);
  const invalidate = () => { setPreview(null); setConsent(false); setResult(null); };
  const selectMode = (key: string) => { invalidate(); setParams(previous => { previous.set('mode', key); return previous; }); };
  const send = (endpoint: string, body: unknown, headers: Record<string, string> = {}) => jsonRequest(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
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
  const testDescription = () => {
    if (mode === 'filter') {
      return 'Prüft Filter und Pfade der aktiven Revision. Führt keinen KI-Aufruf, keine Vertragsvalidierung und keine Order aus.';
    }
    if (mode === 'xml') {
      return 'Prüft die veröffentlichte Vertragsdefinition gegen XML. Grounding wird nur mit bereitgestelltem Quelltext geprüft. Keine Börsenaktion.';
    }
    return 'Tatsächlicher kostenpflichtiger Provideraufruf mit XML- und Grounding-Prüfung. Globale Quoten, Reservierungen und konfigurierte Retry-Grenzen gelten. Erzeugt keine Signale, Intents, Orders oder Versandaufträge.';
  };
  return <div className="operations-stack"><h1>Testlabor</h1><TestLabNav mode={mode} onSelect={selectMode} />
    <p>{testDescription()}</p>
    {error && <p role="alert">{error}</p>}{readOnly && <p>Tests erfordern Administratorrechte. Verbrauch und Einstellungen sind lesbar.</p>}
    <TestLabForm mode={mode} metadata={metadata} pathId={pathId} setParams={setParams} channelId={channelId} setChannelId={setChannelId} contractId={contractId} setContractId={setContractId} contracts={contracts} xml={xml} setXml={setXml} sourceText={sourceText} setSourceText={setSourceText} busy={busy} readOnly={readOnly} invalidate={invalidate} action={action} />
    {mode === 'ai' && <TestPreviewSection preview={preview} consent={consent} setConsent={setConsent} busy={busy} readOnly={readOnly} action={action} />}
    <TestResultSection jobId={jobId} result={result} mode={mode} />
    {metadata && <TestUsageSection metadata={metadata} />}
  </div>;
}
