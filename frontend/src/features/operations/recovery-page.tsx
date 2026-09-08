import { listEntries } from "@/shared/list-entries";
import { useCallback, useState } from "react";
import { jsonRequest, mutateAndObserve } from "@/lib/api";
import { useConfirmationDialog } from "@/components/confirmation-dialog";
import { usePoll } from "@/shared/api/use-poll";
import { AiLimitsForm } from "./ai-limits-form";
import { RuntimeParameters, runtimeInputError } from './runtime-parameters';
import { useVersionedDraft } from '@/shared/forms/use-versioned-draft';
import { useDirtyGuard } from '@/shared/forms/use-dirty-guard';
import { DraftState } from '@/shared/forms/draft-state';

export function RecoveryPage() {
  const [status, setStatus] = useState<any>(null);
  const [serverConfig, setServerConfig] = useState<any>(null);
  const [runtimePayload, setRuntimePayload] = useState<any>(null);
  const configForm = useVersionedDraft<any>('recovery-config', serverConfig, serverConfig?.configRevision ?? null, {});
  const runtimeForm = useVersionedDraft<any>('recovery-runtime', runtimePayload?.settings ?? null, runtimePayload?.revision ?? null, {});
  const { draft: config, setDraft: setConfig } = configForm;
  const { draft: runtime, setDraft: setRuntime } = runtimeForm;
  const [secrets, setSecrets] = useState<Record<string, any>>({});
  const [secretInput, setSecretInput] = useState<Record<string, string>>({});
  useDirtyGuard(Object.values(secretInput).some(Boolean));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [restartFrom, setRestartFrom] = useState("");
  const { confirm, confirmationDialog } = useConfirmationDialog();
  const readStatus = useCallback((signal: AbortSignal) => jsonRequest("/api/recovery", { signal }), []);
  usePoll(readStatus, (value) => { setStatus(value); setErrors((previous) => ({ ...previous, status: "" })); },
    (error) => setErrors((previous) => ({ ...previous, status: error.message })), 3_000);
  const readRepairs = useCallback(async (signal: AbortSignal) => Promise.all(['config', 'runtime-settings', 'secrets'].map(async name => {
    try { return { name, value: await jsonRequest(`/api/${name}`, { signal }), error: '' }; }
    catch (reason) { return { name, value: null, error: reason instanceof Error ? reason.message : String(reason) }; }
  })), []);
  usePoll(readRepairs, results => { for (const result of results) {
    setErrors(previous => ({ ...previous, [result.name]: result.error }));
    if (result.error) continue;
    if (result.name === 'config') setServerConfig(result.value);
    if (result.name === 'runtime-settings') setRuntimePayload(result.value);
    if (result.name === 'secrets') setSecrets(result.value.secrets);
  } }, reason => setErrors(previous => ({ ...previous, repairs: reason.message })), 15_000);
  const can = (action: string) => status?.availableRepairs?.includes(action) === true && !busy;
  const save = async (name: string, body: unknown) => {
    if (!can(name) || (name === 'config' && configForm.conflict) || (name === 'runtime-settings' && runtimeForm.conflict)) return;
    if (name === 'runtime-settings') { const error = runtimeInputError(runtime, runtimePayload?.parameters); if (error) { setMessage(error); return; } }
    setBusy(name); setMessage("");
    try {
      const repairRevision = () => {
        if (name === 'config') {
          return configForm.baseRevision;
        }
        if (name === 'runtime-settings') {
          return runtimeForm.baseRevision;
        }
        return null;
      };
      const revision = repairRevision();
      const { refreshError } = await mutateAndObserve(() => jsonRequest(`/api/${name}`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(revision ? { 'If-Match': String(revision) } : {}) }, body: JSON.stringify(body),
      }), (result) => {
        setMessage(`${name} gespeichert. Wirksamkeit nach geprüftem Neustart beobachten.`);
        if (name === "secrets") setSecretInput({});
        if (name === 'runtime-settings') { setRuntimePayload(result); runtimeForm.saved(result.settings, result.revision ?? runtimeForm.baseRevision); }
        if (name === 'config') { const value = result.configuration ? { ...result.configuration, configRevision: result.configRevision } : config; setServerConfig(value); configForm.saved(value, result.configRevision ?? configForm.baseRevision); }
      }, async () => setStatus(await jsonRequest("/api/recovery")));
      if (refreshError) setMessage(`Gespeichert; Nachladen fehlgeschlagen: ${refreshError}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(""); }
  };
  const restart = async () => {
    if (!await confirm({ title: "Reparatur mit Neustart prüfen", description: "Der Dienst startet mit der gespeicherten Konfiguration neu. Die Oberfläche beobachtet den neuen Prozess; Trading wird nicht automatisch freigegeben.", confirmLabel: "Neu starten", destructive: true })) return;
    setBusy("restart");
    try {
      const result = await jsonRequest("/api/restart", { method: "POST", headers: { "X-Destructive-Confirmation": "restart-service" } });
      setRestartFrom(result.serverInstanceId); setMessage("Neustart angenommen. Warte auf einen bestätigten neuen Prozess.");
    } catch (error) { setMessage(`Neustart nicht bestätigt. Nur Status prüfen, nicht automatisch wiederholen: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(""); }
  };
  const restarted = restartFrom && status?.serverInstanceId && restartFrom !== status.serverInstanceId;
  const recoveryStatus = () => {
    if (status) {
      if (status.active) {
        return "Reparatur erforderlich";
      }
      return "Recovery beendet; Betriebsfreigaben separat prüfen";
    }
    return "wird geprüft";
  };
  return <main className="operations-stack p-6 mx-auto max-w-5xl">
    {confirmationDialog}
    <h1>TSX Core · Recovery</h1>
    <p>Authentifizierung: {status?.session?.role ?? "unbekannt"} · Betriebsbereitschaft: {recoveryStatus()}</p>
    <p>Dieser Einstieg benötigt nur Recovery, Konfiguration, Runtime-Einstellungen und Secretstatus. Alle Reparaturen durchlaufen die bestehenden Serverprüfungen.</p>
    {Object.entries(errors).filter(([, error]) => error).map(([name, error]) => <p role="alert" key={name}>{name}: {error}</p>)}
    {listEntries<any>(status?.issues ?? [], issue => JSON.stringify([issue.component, issue.name, issue.reason])).map(({ item: issue, key }) => <p role="alert" key={key}>{issue.component} {issue.name}: {issue.reason}</p>)}
    {message && <p><output>{message}</output></p>}
    <DraftState label="Recovery-Konfiguration" form={configForm} server={serverConfig} />
    <DraftState label="Recovery-Runtime" form={runtimeForm} server={runtimePayload?.settings} />
    {restarted && <p><output>Neuer Prozess bestätigt · {status.active ? "Recovery bleibt aktiv; Reparatur prüfen." : "Recovery beendet. Öffne das Cockpit und prüfe die Betriebsfreigaben."}</output></p>}
    {status && !status.active && <a className="secondary-button" href={`${import.meta.env.VITE_BASENAME || ""}/cockpit`}>Cockpit öffnen</a>}
    {serverConfig && <section className="operations-card system-form"><h2>Grundkonfiguration reparieren</h2><fieldset disabled={!can('config')}>
      <label>Telegram API-ID<input type="number" value={config.apiId ?? 0} onChange={(event) => setConfig({ ...config, apiId: Number(event.target.value) })} /></label>
      <label>Primärmodell<input value={config.xmlParsing?.primaryModel ?? ""} onChange={(event) => setConfig({ ...config, xmlParsing: { ...config.xmlParsing, primaryModel: event.target.value } })} /></label>
      <label>Fallbackmodell<input value={config.xmlParsing?.fallbackModel ?? ""} onChange={(event) => setConfig({ ...config, xmlParsing: { ...config.xmlParsing, fallbackModel: event.target.value } })} /></label>
      <AiLimitsForm value={config.xmlParsing?.aiLimits ?? {}} onChange={(aiLimits) => setConfig({ ...config, xmlParsing: { ...config.xmlParsing, aiLimits } })} />
      <button className="primary-button" disabled={!can("config") || configForm.conflict} onClick={() => { save("config", { apiId: config.apiId, xmlParsing: config.xmlParsing }); }}>Grundkonfiguration speichern</button>
    </fieldset></section>}
    {runtimePayload && <section className="operations-card system-form"><h2>Runtime reparieren</h2>
      <RuntimeParameters value={runtime} onChange={setRuntime} payload={runtimePayload} readOnly={!can('runtime-settings')} />
      <button className="primary-button" disabled={!can("runtime-settings") || runtimeForm.conflict || !runtimePayload.parameters} onClick={() => { save("runtime-settings", runtime); }}>Runtime speichern</button>
    </section>}
    <section className="operations-card system-form"><h2>Secrets reparieren</h2><p>Write-only. Leeres Feld behält den Wert bei. Extern verwaltete Werte werden an ihrer Quelle geändert.</p>
      {Object.entries(secrets).filter(([name]) => !name.startsWith("dashboard")).map(([name, state]) => <label key={name}>{name} · {state.configured ? "konfiguriert" : "fehlt"} · {state.source}
        <input type="password" autoComplete="off" disabled={!can('secrets') || state.source === "external" || state.editable === false} value={secretInput[name] ?? ""} onChange={(event) => setSecretInput({ ...secretInput, [name]: event.target.value })} /></label>)}
      <button className="primary-button" disabled={!can("secrets") || !Object.values(secretInput).some((value) => value.trim())} onClick={() => { save("secrets", Object.fromEntries(Object.entries(secretInput).filter(([, value]) => value.trim()))); }}>Secrets speichern</button>
    </section>
    <button className="secondary-button" disabled={!can("restart") || Boolean(restartFrom && !restarted)} onClick={() => { restart(); }}>Kontrolliert neu starten</button>
    {status?.session?.role === "viewer" && <p>Viewer dürfen den Zustand lesen. Reparaturen erfordern Administratorrechte.</p>}
  </main>;
}
