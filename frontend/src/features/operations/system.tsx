import { TelegramSettings } from "@/features/signals/telegram-settings";
import { SetupReviewTree } from './setup-review-tree';
import { Metric, time } from "@/shared/components/operator-primitives";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { apiFetch, jsonRequest, mutateAndObserve, setDashboardToken } from "@/lib/api";
import { JobLink } from "@/features/operations/jobs-page";
import { RuntimeParameters, runtimeInputError } from "@/features/operations/runtime-parameters";
import { ChangeReview } from "@/shared/components/change-review";
import { useConfirmationDialog } from "@/components/confirmation-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ExchangeCatalog } from "@/app/workflow/types";
import { useVersionedDraft } from "@/shared/forms/use-versioned-draft";
import { DraftState } from "@/shared/forms/draft-state";
import { useDirtyGuard } from "@/shared/forms/use-dirty-guard";
import { usePoll } from "@/shared/api/use-poll";
import { showIssuedCredential } from "@/shared/components/issued-credential";

function RuntimeEvidence({ payload }: Readonly<{ payload: any }>) {
  const restartRequirement = () => {
    if (payload.restartRequired === true) {
      return 'ja';
    }
    if (payload.restartRequired === false) {
      return 'nein';
    }
    return 'unbekannt';
  };
  return <details><summary>Gespeicherte und aktive Werte · Quelle und Wirkung</summary><p>{payload.precedence ?? 'Quellenvertrag nicht verfügbar.'}</p><p>Quelle: {payload.source ?? 'unbekannt'} · Neustart erforderlich: {restartRequirement()}</p><div className="overflow-x-auto"><table><thead><tr><th>Parameter</th><th>Gespeichert</th><th>Beim Start angewendet</th></tr></thead><tbody>{Object.entries(payload.settings ?? {}).map(([key, value]) => <tr key={key}><th>{key}</th><td>{JSON.stringify(value)}</td><td>{payload.active ? JSON.stringify(payload.active[key]) : 'nicht beobachtet'}</td></tr>)}</tbody></table></div></details>;
}

export function System({
  catalog,
  onRefresh,
}: Readonly<{
  catalog: ExchangeCatalog | null;
  onRefresh: () => Promise<void>;
}>) {
  const [runtimePayload, setRuntimePayload] = useState<any>(null);
  const runtimeForm = useVersionedDraft<any>('runtime', runtimePayload?.settings ?? null, runtimePayload?.revision ?? null, {});
  const { draft: runtime, setDraft: setRuntime } = runtimeForm;
  const [secrets, setSecrets] = useState<any>(null);
  const [recovery, setRecovery] = useState<any>(null);
  const [operations, setOperations] = useState<any>(null);
  const [access, setAccess] = useState<any>(null);
  const [setupPreview, setSetupPreview] = useState<any>(null);
  const [setupMappings, setSetupMappings] = useState<Record<string, string>>({});
  const [setupConfirmation, setSetupConfirmation] = useState("");
  const [dangerConfirmation, setDangerConfirmation] = useState("");
  const [secretInput, setSecretInput] = useState<Record<string, string>>({});
  useDirtyGuard(Object.values(secretInput).some(Boolean));
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const [restartInstance, setRestartInstance] = useState<string | null>(null);
  const [restartJobId, setRestartJobId] = useState('');

  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const { confirm, confirmationDialog } = useConfirmationDialog();
  const load = useCallback(async () => {
    const sources = ['runtime-settings', 'secrets', 'recovery', 'operations', 'access'];
    const results = await Promise.allSettled(sources.map((source) => jsonRequest(`/api/${source}`)));
    const failures: Record<string, string> = {};
    results.forEach((result, index) => {
      const source = sources[index];
      if (result.status === 'rejected') { failures[source] = String(result.reason?.message ?? result.reason); return; }
      const value = result.value;
      if (source === 'runtime-settings') setRuntimePayload(value);
      if (source === 'secrets') setSecrets(value.secrets);
      if (source === 'recovery') setRecovery(value);
      if (source === 'operations') setOperations(value.operations ?? null);
      if (source === 'access') setAccess(value);
    });
    setLoadErrors(failures);
    if (Object.keys(failures).length) throw new Error(Object.entries(failures).map(([name, error]) => `${name}: ${error}`).join(' · '));
  }, []);
  useEffect(() => {
    void load().catch((reason) => setMessage(reason.message));
  }, [load]);
  const observeRestart = useCallback(async (signal: AbortSignal) => restartInstance ? jsonRequest('/api/recovery', { signal }) : null, [restartInstance]);
  usePoll(observeRestart, (value) => {
    if (value && value.serverInstanceId !== restartInstance) {
      setRestartInstance(null); setRecovery(value);
      setMessage(`Neue Dienstinstanz beobachtet. ${value.active ? 'Recovery ist weiterhin aktiv.' : 'Neustart abgeschlossen; Handel benötigt seine eigenen Freigaben.'}`);
    }
  }, () => { if (restartInstance) setMessage('Neustart angefordert. Verbindung unterbrochen; Abschluss noch nicht beobachtet. Es wird kein zweiter Neustart gesendet.'); }, 2_000);
  const execute = async (
    key: string,
    operation: () => Promise<any>,
    success: string,
    accepted: (result: any) => void = () => undefined,
  ) => {
    setBusy(key);
    setMessage("");
    try {
      const { result, refreshError } = await mutateAndObserve(operation, (value) => {
        accepted(value);
        setMessage(success);
      }, () => Promise.all([load(), onRefresh()]));
      if (refreshError) setMessage(`${success} Nachladen fehlgeschlagen; Anzeige möglicherweise veraltet: ${refreshError}`);
      return result;
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
      return null;
    } finally {
      setBusy("");
    }
  };
  const saveSecrets = async () => {
    const secretUpdates = Object.fromEntries(
      Object.entries(secretInput).filter(([, value]) => value.trim()),
    );
    if (!Object.keys(secretUpdates).length) return;
    await execute("secrets", () => jsonRequest("/api/secrets", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(secretUpdates),
    }), "Secrets gespeichert. Leere Felder wurden beibehalten.", () => setSecretInput({}));
  };
  const saveRuntime = async () => {
    if (runtimeForm.conflict) return;
    const inputError = runtimeInputError(runtime, runtimePayload?.parameters);
    if (inputError) { setMessage(inputError); return; }
    await execute(
      "runtime",
      async () => {
        const payload = await jsonRequest("/api/runtime-settings", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(runtimeForm.baseRevision ? { 'If-Match': String(runtimeForm.baseRevision) } : {}) },
          body: JSON.stringify(runtime),
        });
        return payload;
      },
      "Runtime-Einstellungen gespeichert. Ein kontrollierter Neustart ist erforderlich.",
      (payload) => { setRuntimePayload(payload); runtimeForm.saved(payload.settings, payload.revision ?? runtimeForm.baseRevision); },
    );
  };
  const rotateToken = async (role: "admin" | "viewer") => {
    if (!await confirm({
      title: `${role === "admin" ? "Admin" : "Viewer"}-Key rotieren`,
      description: "Der bisherige Key wird sofort ungültig. Der neue Wert wird nur einmal angezeigt.",
      confirmLabel: "Key rotieren",
      destructive: true,
    })) return;
    await execute(
      `token-${role}`,
      () =>
        jsonRequest("/api/access-tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role }),
        }),
      `${role}-Key rotiert. Der neue Wert wird nur jetzt angezeigt.`,
      (result) => {
        if (result?.token) {
          showIssuedCredential(`${role}-Zugangsschlüssel`, result.token);
          if (role === "admin") setDashboardToken(result.token);
        }
      },
    );
  };
  const restart = async () => {
    if (!await confirm({
      title: "Dienst neu starten",
      description: "TSX Core wird kontrolliert neu gestartet und aktiviert die gespeicherten Laufzeiteinstellungen.",
      confirmLabel: "Neu starten",
      destructive: true,
    })) return;
    const jobId = crypto.randomUUID();
    setRestartJobId(jobId);
    const result = await execute(
      "restart",
      () =>
        jsonRequest("/api/restart", {
          method: "POST",
          headers: { "X-Destructive-Confirmation": "restart-service", 'X-Operator-Job-ID': jobId },
        }),
      "Neustart wurde angefordert.",
      (result) => setRestartInstance(result.serverInstanceId ?? recovery?.serverInstanceId ?? 'unknown'),
    );
    if (!result) setMessage('Neustart nicht bestätigt. Verbindung und Recovery prüfen; es wird nicht automatisch erneut gestartet.');
  };
  const revokeViewer = async () => {
    if (!await confirm({
      title: "Viewer-Key widerrufen",
      description: "Der Viewer-Key und alle damit bestehenden Viewer-Anmeldungen werden ungültig.",
      confirmLabel: "Viewer-Key widerrufen",
      destructive: true,
    })) return;
    await execute(
      "viewer-revoke",
      () => jsonRequest("/api/access-tokens/viewer", {
        method: "DELETE",
        headers: { "X-Destructive-Confirmation": "disable-viewer-token" },
      }),
      "Viewer-Key wurde widerrufen.",
    );
  };
  const replayAudit = async () => {
    await execute(
      "audit-replay",
      () => jsonRequest("/api/operations/audit-replay", {
        method: "POST",
        headers: { "X-Destructive-Confirmation": "replay-audit" },
      }),
      "Ausstehende Audit-Ereignisse wurden erneut übertragen.",
    );
  };
  const exportSetup = async () => {
    setBusy("setup-export");
    setMessage("");
    try {
      const response = await apiFetch("/api/setup-bundle/export");
      if (!response.ok) throw new Error(`Setup-Export fehlgeschlagen (${response.status}).`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `tsx-core-setup-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage("Geheimnisfreies Setup-Bundle exportiert.");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };
  const previewSetup = async (file: File | null) => {
    if (!file) return;
    setBusy("setup-preview");
    setMessage("");
    setSetupPreview(null);
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error("Setup-Bundle ist größer als 4 MB.");
      const bundle = JSON.parse(await file.text());
      const preview = await jsonRequest("/api/setup-bundle/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundle }),
      });
      setSetupPreview(preview);
      setSetupMappings(preview.accountMapping?.automatic || {});
      setSetupConfirmation("");
      setMessage("Bundle validiert. Prüfe Diff und Kontozuordnung vor der Anwendung.");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };
  const applySetup = async () => {
    if (!setupPreview) return;
    const result = await execute(
      "setup-apply",
      () => jsonRequest("/api/setup-bundle/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          previewKey: setupPreview.previewKey,
          confirmation: setupConfirmation,
          accountMappings: setupMappings,
        }),
      }),
      "Setup wurde nach verifizierter Sicherung vollständig ersetzt.",
    );
    if (result) {
      setSetupPreview(null);
      setSetupMappings({});
      setSetupConfirmation("");
    }
  };
  const dangerAction = async (kind: "clear" | "factory") => {
    const expected = kind === "clear" ? "DATENBANK LEEREN" : "FACTORY RESET";
    if (dangerConfirmation !== expected) return;
    const jobId = kind === 'factory' ? crypto.randomUUID() : undefined;
    if (jobId) setRestartJobId(jobId);
    const result = await execute(
      `danger-${kind}`,
      () => jsonRequest(kind === "clear" ? "/api/clear-database" : "/api/factory-reset", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Destructive-Confirmation": kind === "clear" ? "clear-database" : "factory-reset",
        },
        body: JSON.stringify({ confirmation: expected, ...(jobId ? { jobId } : {}) }),
      }),
      kind === "clear" ? "Betriebsdatenbank wurde geleert." : "Factory Reset wurde gestartet.",
    );
    if (result && kind === "factory") {
      setRestartInstance(recovery?.serverInstanceId ?? 'unknown');
      setMessage('Factory Reset bestätigt. Wiederanlauf wird beobachtet; nach Widerruf der bisherigen Anmeldung ist die Ersteinrichtung erneut erforderlich.');
    }
    if (!result && kind === 'factory') setMessage('Factory Reset nicht bestätigt. Zuerst Auftrag und Recovery prüfen; keine automatische Wiederholung.');
    if (result) setDangerConfirmation("");
  };
  const auditStatus = () => {
    if (operations?.audit?.healthy === false) {
      return "gestört";
    }
    if (operations?.audit?.healthy === true) {
      return "bereit";
    }
    return "unbekannt";
  };
  return (
    <div className="operations-stack">
      {confirmationDialog}
      {message && <div className="builder-info">{message}</div>}
      {Object.entries(loadErrors).map(([source, error]) => <p key={source} role="alert">{source}: {error}. Vorhandene Daten können veraltet sein.</p>)}
      {restartJobId && <JobLink id={restartJobId} />}
      <DraftState label="Runtime" form={runtimeForm} server={runtimePayload?.settings} />
      {recovery?.active && (
        <div className="builder-error">
          <AlertTriangle size={15} />
          Recovery-Modus:{" "}
          {(recovery.issues || []).map((item: any) => item.reason).join(" · ")}
        </div>
      )}
      <TelegramSettings />
      {runtimePayload ? <section className="operations-card system-form">
        <h3>Dashboard-Zugriff & Runtime</h3>
        <RuntimeParameters value={runtime} onChange={setRuntime} payload={runtimePayload} />
        <button
          type="button"
          className="primary-button"
          disabled={Boolean(busy) || runtimeForm.conflict}
          onClick={() => void saveRuntime()}
        >
          Runtime speichern
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={Boolean(busy)}
          onClick={() => void restart()}
        >
          Kontrolliert neu starten
        </button>
        <RuntimeEvidence payload={runtimePayload} />
      </section> : <p>Runtime-Einstellungen nicht verfügbar.</p>}
      <section className="operations-card system-form">
        <h3>Write-only Enterprise-Secrets</h3>
        <div className="runtime-grid">
          {[
            "auditWebhookToken",
            "alertRelayToken",
            "alertWebhookToken",
            "backupOffsiteToken",
            "backupEncryptionKey",
          ].map((name) => (
            <label key={name}>
              {name} · {secrets?.[name]?.configured ? "gespeichert" : "fehlt"}
              <input
                type="password"
                autoComplete="off"
                value={secretInput[name] || ""}
                onChange={(event) =>
                  setSecretInput({ ...secretInput, [name]: event.target.value })
                }
              />
            </label>
          ))}
        </div>
        <button
          type="button"
          className="primary-button"
          disabled={Boolean(busy)}
          onClick={() => void saveSecrets()}
        >
          Secrets sicher speichern
        </button>
      </section>
      <section className="operations-card">
        <h3>Zugriffsschlüssel</h3>
        <div className="system-line">
          <span>Aktuelle Identität</span>
          <strong>{access?.identity?.name || access?.identity?.login || access?.actorId || "unbekannt"} · {access?.role || "–"}</strong>
        </div>
        <div className="system-line">
          <span>Remote-Verbindung</span>
          <strong>{access?.remoteAccess?.connected ? `${access.remoteAccess.provider} verbunden` : "nicht verbunden"}</strong>
        </div>
        <div className="system-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={Boolean(busy)}
            onClick={() => void rotateToken("admin")}
          >
            Admin-Key rotieren
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={Boolean(busy)}
            onClick={() => void rotateToken("viewer")}
          >
            Viewer-Key erzeugen/rotieren
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={Boolean(busy)}
            onClick={() => void revokeViewer()}
          >
            Viewer-Key widerrufen
          </button>
        </div>

      </section>
      <section className="operations-card setup-bundle-card">
        <h3>Portables Setup-Bundle</h3>
        <p className="operations-help">Exportiert Builder, Parser, Verträge, Strategien und nicht-geheime Einstellungen. Zugangsdaten, Tokens, Tailscale-Identitäten, Nachrichten, Logs, Journal und Backups bleiben ausgeschlossen.</p>
        <div className="system-actions">
          <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => void exportSetup()}>Setup exportieren</Button>
          <label className="secondary-button setup-file-button">
            {busy === "setup-preview" ? "Prüfe Bundle…" : "Bundle auswählen"}
            <input type="file" accept="application/json,.json" disabled={Boolean(busy)} onChange={(event) => { void previewSetup(event.target.files?.[0] || null); event.currentTarget.value = ""; }} />
          </label>
        </div>
        {setupPreview && (
          <div className="setup-preview">
            <div className="setup-diff-grid">
              <Metric label="Aktuelle Bausteine" value={setupPreview.diff.current.nodes} />
              <Metric label="Import-Bausteine" value={setupPreview.diff.imported.nodes} />
              <Metric label="Import-Verbindungen" value={setupPreview.diff.imported.edges} />
              <Metric label="Import-Ressourcen" value={setupPreview.diff.imported.resources} />
            </div>
            <p>Vorschau gültig bis {time(setupPreview.expiresAt)} · Prüfsumme {String(setupPreview.bundleHash).slice(0, 16)}…</p>
            {setupPreview.contentReview ? <><p>{setupPreview.contentReview.effect}</p>
              {setupPreview.contentReview.paged ? <SetupReviewTree previewKey={setupPreview.previewKey} /> : <><ChangeReview before={setupPreview.contentReview.before} after={setupPreview.contentReview.after} label="Setup-Inhalte vor und nach dem Import" />
              <details><summary>Vorhandene Bibliothek einschließlich ungebundener Entwürfe prüfen</summary><ChangeReview after={setupPreview.contentReview.existingLibrary} showAll label="Vorhandene Bibliothek" /></details></>}
              <p>Änderungen an Konfiguration, Bibliothek, Kontostand oder aktivem Workflow machen diese Vorschau ungültig. Vor dem Ersetzen erstellt der Server ein Backup.</p></> : <p role="alert">Inhaltlicher Vergleich nicht verfügbar. Neue Serverversion bzw. neue Vorschau erforderlich.</p>}
            {(setupPreview.accountReferences || []).map((reference: any) => (
              <label key={reference.sourceAccountId}>
                <span>{reference.name} · {reference.exchange}/{reference.mode}</span>
                <select value={setupMappings[reference.sourceAccountId] || ""} onChange={(event) => setSetupMappings((value) => ({ ...value, [reference.sourceAccountId]: event.target.value }))}>
                  <option value="">Lokales Konto zuordnen</option>
                  {(setupPreview.accountMapping?.candidates || []).filter((candidate: any) => candidate.exchange === reference.exchange && candidate.mode === reference.mode).map((candidate: any) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                </select>
              </label>
            ))}
            <label>
              <span>Zum Ersetzen exakt „{setupPreview.confirmation}“ eingeben</span>
              <Input autoComplete="off" value={setupConfirmation} onChange={(event) => setSetupConfirmation(event.target.value)} />
            </label>
            <Button type="button" variant="destructive" disabled={Boolean(busy) || !setupPreview.contentReview || setupConfirmation !== setupPreview.confirmation || (setupPreview.accountReferences || []).some((reference: any) => !setupMappings[reference.sourceAccountId])} onClick={() => void applySetup()}>
              {busy === "setup-apply" ? "Sichere und ersetze…" : "Bestehendes Setup sicher ersetzen"}
            </Button>
          </div>
        )}
      </section>
      <section className="operations-card">
        <h3>Audit und Diagnose</h3>
        <div className="system-line"><span>Audit-Zustand</span><strong>{auditStatus()}</strong></div>
        <div className="system-line"><span>Letzte Integritätsprüfung</span><strong>{time(operations?.backup?.integrityVerified?.verifiedAt)}</strong></div>
        <div className="system-line"><span>Geprüfter Datenstand erstellt</span><strong>{time(Date.parse(operations?.backup?.integrityVerified?.artifactCreatedAt))}</strong></div>
        <div className="system-line"><span>Gemeinsame Konfiguration geprüft</span><strong>{time(operations?.backup?.configurationCoherent?.verifiedAt)}</strong></div>
        <div className="system-line"><span>Offsite zurückgelesen und geprüft</span><strong>{time(operations?.backup?.offsiteVerified?.verifiedAt)}</strong></div>
        <div className="system-line"><span>Letzte artefaktlokale Restore-Prüfung</span><strong>{operations?.backup?.restoreEligibility?.status || "unknown"} · {time(operations?.backup?.restoreEligibility?.checkedAt)}</strong></div>
        <div className="system-line"><span>Letzter tatsächlich durchgeführter Probelauf</span><strong>{time(operations?.backup?.restoreDrill?.performedAt)}</strong></div>
        <p>Die Restore-Prüfung betrifft nur das Artefakt. Sie belegt weder heutige Börsenflatheit noch eine spätere Handelsfreigabe.</p>
        <div className="system-actions">
          <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => void replayAudit()}>Audit erneut übertragen</Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void (async () => {
              try {
                const response = await apiFetch('/api/status');
                if (!response.ok) throw new Error(`Diagnose nicht verfügbar (${response.status}).`);
                const url = URL.createObjectURL(await response.blob());
                const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'tsx-core-diagnose.json'; anchor.click(); URL.revokeObjectURL(url);
              } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
            })()}
          >
            Diagnosestatus öffnen
          </Button>
        </div>
      </section>
      <section className="operations-card">
        <h3>Exchange Engine</h3>
        <div className="system-line">
          <span>Bibliothek</span>
          <strong>
            {catalog?.implementation.library || "ccxt"}{" "}
            {catalog?.implementation.version}
          </strong>
        </div>
        <div className="system-line">
          <span>Private Streams</span>
          <strong>{catalog?.implementation.streaming || "ccxt-pro"}</strong>
        </div>
        <div className="system-line">
          <span>Order-Autorität</span>
          <strong>{catalog?.implementation.orderAuthority || "rest"}</strong>
        </div>
        {catalog?.exchanges.map((exchange) => (
          <div className="system-line" key={exchange.id}>
            <span>{exchange.name} · {exchange.status}</span>
            <strong>{exchange.reason || exchange.modes.join(" · ") || "nicht ausführbar"}</strong>
          </div>
        ))}
      </section>
      <section className="operations-card danger-zone">
        <h3>Gefahrenzone</h3>
        <p>Nur mit Administratorrolle und einer aktuellen, gesunden Sicherung. „Datenbank leeren“ bewahrt Trading-Zustand gemäß Serverrichtlinie; Factory Reset entfernt die vollständige lokale Installation.</p>
        <div className="system-line"><span>Sicherung</span><strong>{operations?.backup?.healthy && operations?.backup?.restoreEligibility?.status === "eligible" ? `lokal wiederherstellbar · ${time(operations.backup.integrityVerified?.verifiedAt)}` : "nicht aktuell oder nicht wiederherstellbar – Aktion gesperrt"}</strong></div>
        <label><span>Bestätigung</span><Input autoComplete="off" value={dangerConfirmation} onChange={(event) => setDangerConfirmation(event.target.value)} placeholder="DATENBANK LEEREN oder FACTORY RESET" /></label>
        <div className="system-actions">
          <Button type="button" variant="destructive" disabled={Boolean(busy) || !operations?.backup?.healthy || operations?.backup?.restoreEligibility?.status !== "eligible" || dangerConfirmation !== "DATENBANK LEEREN"} onClick={() => void dangerAction("clear")}>Datenbank leeren</Button>
          <Button type="button" variant="destructive" disabled={Boolean(busy) || !operations?.backup?.healthy || operations?.backup?.restoreEligibility?.status !== "eligible" || dangerConfirmation !== "FACTORY RESET"} onClick={() => void dangerAction("factory")}>Factory Reset</Button>
        </div>
      </section>
    </div>
  );
}
