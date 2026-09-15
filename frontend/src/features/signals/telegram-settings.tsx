import { useCallback, useState } from 'react';
import { jsonRequest, mutateAndObserve } from '@/lib/api';
import { Link } from '@/lib/navigation';
import { usePoll } from '@/shared/api/use-poll';
import { useOperatorReadOnly } from '@/shared/api/operator-session';
import { useVersionedDraft } from '@/shared/forms/use-versioned-draft';
import { useDirtyGuard } from '@/shared/forms/use-dirty-guard';
import { DraftState } from '@/shared/forms/draft-state';
import { ChangeReview } from '@/shared/components/change-review';
import { EvidenceFields } from '@/shared/components/evidence';
import { AiLimitsForm } from '@/features/operations/ai-limits-form';
import { AI_LIMIT_RANGES } from '../../../../src/ui_contracts';

const CONFIG_KEYS = ['apiId', 'sourceChannels', 'targetChannel', 'forwardOptions', 'filters', 'sourceFilters', 'sourceAliases', 'xmlParsing', 'dupeBlocker'];
const configValues = (value: any) => Object.fromEntries(CONFIG_KEYS.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
function Lines({ label, value, onChange }: Readonly<{ label: string; value?: string[]; onChange: (value: string[]) => void }>) {
  return <label>{label}<textarea rows={3} value={(value ?? []).join('\n')} onChange={event => onChange(event.target.value.split('\n'))} onBlur={event => onChange(event.target.value.split('\n').filter(line => line !== ''))} /><small>Ein Eintrag je Zeile; leer bedeutet keine Einträge.</small></label>;
}
function Toggle({ label, value, onChange }: Readonly<{ label: string; value: boolean; onChange: (value: boolean) => void }>) {
  return <label className="builder-toggle"><input type="checkbox" checked={value === true} onChange={event => onChange(event.target.checked)} /><span aria-hidden="true" />{label}</label>;
}

/** One configuration/control surface, embedded by System and independently addressable under Signals. */
export function TelegramSettings() {
  const readOnly = useOperatorReadOnly();
  const [server, setServer] = useState<any>(null); const [status, setStatus] = useState<any>(null); const [secrets, setSecrets] = useState<any>(null);
  const [errors, setErrors] = useState<Record<string, string>>({}); const [refresh, setRefresh] = useState(0);
  const form = useVersionedDraft<any>('telegram-config', server?.values ?? null, server?.revision ?? null, {});
  const config = form.draft; const xml = config.xmlParsing ?? {}; const forward = config.forwardOptions ?? {}; const filters = config.filters ?? {}; const dupe = config.dupeBlocker ?? {};
  const [secretInput, setSecretInput] = useState<Record<string, string>>({}); const [loginInput, setLoginInput] = useState({ value: '', firstName: '', lastName: '' });
  useDirtyGuard(Object.values(secretInput).some(Boolean) || Object.values(loginInput).some(Boolean));
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [normalization, setNormalization] = useState<any>(null); const [source, setSource] = useState('');
  const readConfig = useCallback((signal: AbortSignal) => jsonRequest('/api/config', { signal }), []);
  const readStatus = useCallback((signal: AbortSignal) => jsonRequest('/api/status', { signal }), []);
  const readSecrets = useCallback((signal: AbortSignal) => readOnly ? Promise.resolve(null) : jsonRequest('/api/secrets', { signal }), [readOnly]);
  const failure = (key: string, error: string) => setErrors(previous => ({ ...previous, [key]: error }));
  usePoll(readConfig, value => { setServer({ values: configValues(value), revision: value.configRevision ?? null }); failure('Konfiguration', ''); }, error => failure('Konfiguration', error.message), 5000, refresh);
  usePoll(readStatus, value => { setStatus(value); failure('Verbindung', ''); }, error => failure('Verbindung', error.message), 5000, refresh);
  usePoll(readSecrets, value => { setSecrets(value?.secrets ?? null); failure('Zugangsdaten', ''); }, error => failure('Zugangsdaten', error.message), 5000, refresh);
  const edit = (key: string, value: unknown) => form.setDraft({ ...config, [key]: value });
  const editXml = (key: string, value: unknown) => edit('xmlParsing', { ...xml, [key]: value });
  const command = async (url: string, body: unknown, accepted: (result: any) => void, description: string, headers: Record<string, string> = {}) => {
    if (readOnly) return;
    setBusy(true); setMessage('');
    try {
      await mutateAndObserve(() => jsonRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }), result => { const receipt = result.requestId ? ` · Anfrage ${result.requestId}` : ''; setMessage(`${description}${receipt}`); accepted(result); }, async () => setRefresh(value => value + 1));
    } catch (error) { setMessage(`Nicht bestätigt. Keine automatische Wiederholung: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!form.baseRevision || form.conflict) return;
    if (!Number.isSafeInteger(config.apiId) || config.apiId < 0 || !Number.isSafeInteger(forward.maxConcurrency) || forward.maxConcurrency < 1 || forward.maxConcurrency > 100 || !Number.isSafeInteger(forward.queueTimeoutSeconds) || forward.queueTimeoutSeconds < 0 || forward.queueTimeoutSeconds > 86400 || !Number.isFinite(dupe.cooldownHours) || dupe.cooldownHours < 0 || (xml.timeout !== undefined && (!Number.isSafeInteger(xml.timeout) || xml.timeout < 0))) {
      setMessage('API ID, Queue und Legacy-Zeitlimits müssen innerhalb der angezeigten Grenzen liegen.'); return;
    }
    for (const [key, [minimum, maximum]] of Object.entries(AI_LIMIT_RANGES)) {
      if (!Number.isSafeInteger(xml.aiLimits?.[key]) || xml.aiLimits[key] < minimum || xml.aiLimits[key] > maximum) { setMessage(`${key}: Ganzzahl zwischen ${minimum} und ${maximum} erforderlich.`); return; }
    }
    const desired = configValues(config);
    await command('/api/config', desired, result => {
      const saved = configValues(result.configuration);
      if (!result.configuration || !result.configRevision) { setMessage('Speichern bestätigt, aber normalisierter Antwortvertrag fehlt. Konfiguration neu laden und vergleichen.'); return; }
      setNormalization({ before: desired, after: saved }); setServer({ values: saved, revision: result.configRevision }); form.saved(saved, result.configRevision);
    }, 'Telegram- und KI-Grundkonfiguration gespeichert. Zurückgegebene Werte und Queue-Zustand prüfen.', { 'If-Match': String(form.baseRevision) });
  };
  const prompt = status?.telegramLogin?.prompt;
  const canStop = status?.isRunning === true || ['connecting', 'authentication-required'].includes(status?.connectionState);
  const sourceIds = [...new Set<string>([...(config.sourceChannels ?? []), ...Object.keys(config.sourceFilters ?? {}), ...Object.keys(config.sourceAliases ?? {}), ...Object.keys(xml.sourceTemplates ?? {})])].filter(Boolean);
  const sourceFilter = config.sourceFilters?.[source];
  const loginPrompt = () => {
    if (prompt?.kind === 'otherDeviceConfirmation') {
      if (/^tg:\/\/|^https:\/\/(?:[a-z]+\.)?telegram\.org\//i.test(prompt.link ?? '')) {
        return <a href={prompt.link} target="_blank" rel="noreferrer">In Telegram bestätigen</a>;
      }
      return <p>Telegram-Link nicht als zulässiger Anmeldelink erkennbar.</p>;
    }
    return <>{prompt?.kind === 'name' ? <div className="builder-field-grid"><label>Vorname<input value={loginInput.firstName} onChange={event => setLoginInput({ ...loginInput, firstName: event.target.value })} /></label><label>Nachname<input value={loginInput.lastName} onChange={event => setLoginInput({ ...loginInput, lastName: event.target.value })} /></label></div> : <label>{prompt?.label}<input type={prompt?.kind === 'password' ? 'password' : 'text'} autoComplete="off" value={loginInput.value} onChange={event => setLoginInput({ ...loginInput, value: event.target.value })} /></label>}
      <button className="primary-button" onClick={() => { command('/api/telegram-login', prompt?.kind === 'name' ? { firstName: loginInput.firstName, lastName: loginInput.lastName } : { value: loginInput.value }, () => setLoginInput({ value: '', firstName: '', lastName: '' }), 'Anmeldedaten angenommen; Verbindung wird weiter beobachtet.'); }}>Weiter</button></>;
  };
  return <div className="operations-stack"><h2>Telegram & KI-Grundlage</h2>
    {Object.entries(errors).filter(([, error]) => error).map(([key, error]) => <p role="alert" key={key}>{key}: {error} · Vorhandene Daten können veraltet sein.</p>)}
    {message && <p><output>{message}</output></p>}{readOnly && <p>Nur Lesezugriff. Änderungen und Anmeldung benötigen die Adminrolle.</p>}
    <section className="operations-card system-form"><h3>Telegram-Routing</h3><EvidenceFields fields={[["Verbindung", status?.connectionState], ["Dienst läuft", status?.isRunning], ["Beobachtete Quellen", status?.resolvedSources?.length], ["Queue · aktiv", status?.queue?.running], ["Queue · wartend", status?.queue?.queued]]} />
      <fieldset disabled={readOnly || busy || !status || Boolean(errors.Verbindung)}><button className="primary-button" disabled={canStop} onClick={() => { command('/api/control', { action: 'start' }, () => undefined, 'Verbindungsaufbau angefordert; Erfolg erst durch den Verbindungszustand bestätigt.'); }}>Starten</button><button className="secondary-button" disabled={!canStop} onClick={() => { command('/api/control', { action: 'stop' }, () => undefined, 'Telegram-Routing gestoppt. Bestehende Trades und deren Schutz laufen gesondert weiter.'); }}>Stoppen</button></fieldset>
      {status?.telegramLogin?.state === 'waiting' && <fieldset disabled={readOnly || busy}><legend>Telegram-Anmeldung · {prompt?.label}</legend>
        {loginPrompt()}
      </fieldset>}
    </section>
    <DraftState label="Grundkonfiguration" form={form} server={server?.values} />
    {server ? <section className="operations-card system-form"><h3>Globale Quellen, Parser und Queue</h3>
      <p>Queue und globale KI-Grenzen gelten für künftige Arbeit. Telegram-Verbindungsdaten und Quellen werden beim nächsten Verbindungsaufbau aufgelöst. <Link to="/workflows/paths">Aktive Workflow-Pfade</Link> besitzen eigene gepinnte Filter, Parser-, Dedupe- und Ausgabeparameter; neue globale Legacy-Werte schreiben bestehende Nachrichten und Trades nicht um.</p>
      <fieldset disabled={readOnly || busy || !form.baseRevision}><div className="builder-field-grid"><label>Telegram API ID<input type="number" min={0} step={1} value={config.apiId ?? ''} onChange={event => edit('apiId', Number(event.target.value))} /></label><label>Telegram-Ziel (globale Vorgabe)<input value={config.targetChannel ?? ''} onChange={event => edit('targetChannel', event.target.value)} /></label>
        <label>Queue · Parallelität<input type="number" min={1} max={100} step={1} value={forward.maxConcurrency ?? ''} onChange={event => edit('forwardOptions', { ...forward, maxConcurrency: Number(event.target.value) })} /></label><label>Queue · Zeitlimit (Sekunden)<input aria-label="Queue · Zeitlimit (Sekunden)" type="number" min={0} max={86400} step={1} value={forward.queueTimeoutSeconds ?? ''} onChange={event => edit('forwardOptions', { ...forward, queueTimeoutSeconds: Number(event.target.value) })} /><small>0 deaktiviert das Queue-Zeitlimit. Bei aktivem globalem Parser erhöht der Server einen positiven Wert auf mindestens Requesttimeout + 5 Sekunden.</small></label>
        <label>Primärmodell<input maxLength={128} value={xml.primaryModel ?? ''} onChange={event => editXml('primaryModel', event.target.value)} /></label><label>Fallback-Modell<input maxLength={128} value={xml.fallbackModel ?? ''} onChange={event => editXml('fallbackModel', event.target.value)} /></label></div>
        <Toggle label="Externe KI-Datenverarbeitung freigegeben" value={xml.externalDataPolicyAccepted} onChange={value => editXml('externalDataPolicyAccepted', value)} />
        <AiLimitsForm value={xml.aiLimits ?? {}} onChange={value => editXml('aiLimits', value)} />
        <details><summary>Globaler Legacy-Signalweg · Quellen, Filter und Ausgabe</summary><p>Wirkt für neu angenommene Nachrichten ohne aktive Workflowrevision. Workflow-Bausteine werden im Builder geändert. Dateiausgabe ist ausschließlich eine Legacy-Option.</p>
          <Lines label="Globale Quellkanäle" value={config.sourceChannels} onChange={value => edit('sourceChannels', value)} />
          <div className="builder-field-grid"><Lines label="Erforderliche Keywords (mindestens eines)" value={filters.allowedKeywords} onChange={value => edit('filters', { ...filters, allowedKeywords: value })} /><Lines label="Gesperrte Keywords" value={filters.blockedKeywords} onChange={value => edit('filters', { ...filters, blockedKeywords: value })} /><Lines label="Erlaubte Inhaltstypen" value={filters.allowedTypes} onChange={value => edit('filters', { ...filters, allowedTypes: value })} /><Lines label="Globale Regex-Muster" value={filters.regexPatterns} onChange={value => edit('filters', { ...filters, regexPatterns: value })} /></div>
          <Toggle label="Originalnachrichten an das globale Ziel weiterleiten" value={forward.forwardToTarget ?? true} onChange={value => edit('forwardOptions', { ...forward, forwardToTarget: value })} /><Toggle label="Als Kopie senden" value={forward.sendCopy} onChange={value => edit('forwardOptions', { ...forward, sendCopy: value })} /><Toggle label="Mediencaption entfernen" value={forward.removeCaption} onChange={value => edit('forwardOptions', { ...forward, removeCaption: value })} />
          <Toggle label="Globalen Legacy-Parser verwenden" value={xml.enabled} onChange={value => editXml('enabled', value)} /><Toggle label="Legacy-XML an globales Ziel senden" value={xml.forwardXmlToTarget} onChange={value => editXml('forwardXmlToTarget', value)} /><Toggle label="Legacy-Signaldateien speichern" value={xml.saveToFile} onChange={value => editXml('saveToFile', value)} />
          <label>Legacy-Signalverzeichnis<input value={xml.signalsDir ?? ''} onChange={event => editXml('signalsDir', event.target.value)} /><small>Speicherort für erzeugte Legacy-Signaldateien; kein Shell- oder Wartungsbefehl.</small></label>
          <label>Legacy-Parser-Gesamtzeitlimit (ms)<input type="number" min={0} step={1} value={xml.timeout ?? ''} onChange={event => editXml('timeout', event.target.value === '' ? 0 : Number(event.target.value))} /><small>Leer oder 0 verwendet den bestehenden Parserstandard. Globaler Requesttimeout und Workflow-Parserzeitlimit gelten separat.</small></label>
          <Toggle label="Globale Duplikatsperre" value={dupe.enabled} onChange={value => edit('dupeBlocker', { ...dupe, enabled: value })} /><label>Duplikat-Cooldown (Stunden)<input type="number" min={0} value={dupe.cooldownHours ?? ''} onChange={event => edit('dupeBlocker', { ...dupe, cooldownHours: Number(event.target.value) })} /><small>0 sperrt identische Signale dauerhaft. Keine Wiederholung bereits angenommener Orders oder unbekannter Sendungen.</small></label>
          <h4>Kanalbezogene globale Vorgaben</h4><label>Konfigurierter Quellkanal<select value={source} onChange={event => setSource(event.target.value)}><option value="">Kanal wählen</option>{sourceIds.map(id => <option key={id}>{id}</option>)}</select></label>
          {source && <div className="system-form"><label>Quellalias<input value={config.sourceAliases?.[source] ?? ''} onChange={event => edit('sourceAliases', { ...config.sourceAliases, [source]: event.target.value })} /><small>Leer zeigt die Kanal-ID. Der Alias dient auch der Eingangsanzeige.</small></label>
            <label>Legacy-Parservorlage<input value={xml.sourceTemplates?.[source] ?? ''} onChange={event => editXml('sourceTemplates', { ...xml.sourceTemplates, [source]: event.target.value })} /><small>Leer verwendet die Standardvorlage.</small></label>
            <Toggle label="Globale Regex-Muster für diesen Kanal überschreiben" value={Array.isArray(sourceFilter?.regexPatterns)} onChange={value => edit('sourceFilters', { ...config.sourceFilters, [source]: value ? { ...sourceFilter, regexPatterns: [] } : null })} />
            {Array.isArray(sourceFilter?.regexPatterns) ? <Lines label="Kanal-Regex-Muster" value={sourceFilter.regexPatterns} onChange={value => edit('sourceFilters', { ...config.sourceFilters, [source]: { ...sourceFilter, regexPatterns: value } })} /> : <p>Erbt die globalen Regex-Muster. Beim Speichern entfernt der Server die aufgehobene Kanalvorgabe.</p>}
          </div>}
        </details>
        <ChangeReview before={server.values} after={config} label="Zu speichernde Konfigurationsänderungen" />
        <button className="primary-button" disabled={form.conflict} onClick={() => { save(); }}>Grundkonfiguration speichern</button>
      </fieldset>{!form.baseRevision && <p role="alert">Versionsvertrag fehlt. Speichern benötigt eine kompatible Serverversion.</p>}
      {normalization && <ChangeReview before={normalization.before} after={normalization.after} label="Servernormalisierung nach dem Speichern" />}
    </section> : <p>Grundkonfiguration wird geladen.</p>}
    {!readOnly && <section className="operations-card system-form"><h3>Telegram-/KI-Zugangsdaten</h3><fieldset disabled={busy || !secrets}>{[['telegramApiHash', 'Telegram API Hash'], ['openRouterApiKey', 'OpenRouter API Key']].map(([key, label]) => {
      const secretStatus = () => {
        if (secrets?.[key]?.configured) {
          return 'gespeichert';
        }
        if (secrets) {
          return 'fehlt';
        }
        return 'unbekannt';
      };
      return (<label key={key}>{label} · {secretStatus()}<input type="password" autoComplete="off" placeholder="Leer lassen zum Beibehalten" value={secretInput[key] ?? ''} onChange={event => setSecretInput({ ...secretInput, [key]: event.target.value })} /></label>);
    })}
      <button className="secondary-button" disabled={!Object.values(secretInput).some(value => value.trim())} onClick={() => { command('/api/secrets', Object.fromEntries(Object.entries(secretInput).filter(([, value]) => value.trim())), () => setSecretInput({}), 'Zugangsdaten gespeichert. Die Konfiguration wurde durch diese Aktion nicht geändert.'); }}>Telegram-/KI-Zugangsdaten speichern</button></fieldset></section>}
  </div>;
}
