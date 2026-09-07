import { useCallback, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { jsonRequest, mutateAndObserve } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConfirmationDialog } from '@/components/confirmation-dialog';
import { useVersionedDraft } from '@/shared/forms/use-versioned-draft';
import { DraftState } from '@/shared/forms/draft-state';
import { useDirtyGuard } from '@/shared/forms/use-dirty-guard';
import { useOperatorReadOnly } from '@/shared/api/operator-session';
import { usePoll } from '@/shared/api/use-poll';
import { Metric, Empty, time } from '@/shared/components/operator-primitives';
type TelegramViewerSettings = {
  enabled: boolean;
  allowedUserIds: string[];
  timezone: string;
  locale: string;
  eventPollingIntervalMs: number;
  notifications: Record<string, boolean>;
  display: { detailLevel: "compact" | "normal" | "detailed"; pnlMode: "absolute" | "absolute_and_percent"; timeFormat: "24h" };
};

const TELEGRAM_NOTIFICATION_LABELS: Array<[string, string]> = [
  ["positionOpened", "Position eröffnet"],
  ["takeProfitFilled", "Take Profit ausgeführt"],
  ["stopLossFilled", "Stop Loss ausgeführt"],
  ["positionClosed", "Position geschlossen"],
  ["executionFailed", "Ausführung fehlgeschlagen"],
  ["accountIncidentOpened", "Konto-Incident eröffnet"],
  ["accountIncidentResolved", "Konto-Incident gelöst"],
  ["exchangeStreamDegraded", "Börsenstream gestört"],
  ["exchangeStreamRecovered", "Börsenstream wiederhergestellt"],
  ["killSwitchActivated", "Kill-Switch aktiviert"],
  ["signalReceived", "Signal empfangen"],
  ["signalValidated", "Signal validiert"],
  ["intentCreated", "Intent erzeugt"],
  ["exchangeAcknowledged", "Börse bestätigt"],
];

function viewerServiceHealth(service: { reachable?: boolean; healthy?: boolean }) {
  if (service.reachable === false) return 'nicht erreichbar';
  if (service.reachable !== true) return 'unbekannt';
  if (service.healthy === true) return 'gesund';
  return service.healthy === false ? 'gestört' : 'unbekannt';
}

export function TelegramViewer() {
  const [payload, setPayload] = useState<any>(null);
  const readOnly = useOperatorReadOnly();
  const serverSettings = payload?.settings ? { ...payload.settings, allowedUsersText: (payload.settings.allowedUserIds ?? []).join('\n') } : null;
  const form = useVersionedDraft<TelegramViewerSettings & { allowedUsersText: string } | null>('telegram-viewer', serverSettings, payload?.settingsRevision ?? null, null);
  const { draft: settings, setDraft: setSettings } = form;
  const allowedUsers = settings?.allowedUsersText ?? '';
  const setAllowedUsers = (value: string) => setSettings(previous => previous ? { ...previous, allowedUsersText: value } : previous);
  const [botToken, setBotToken] = useState("");
  useDirtyGuard(Boolean(botToken));
  const [testMessage, setTestMessage] = useState("TSX Core Telegram Viewer Test");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const { confirm, confirmationDialog } = useConfirmationDialog();
  const [loadError, setLoadError] = useState('');
  const load = useCallback(async () => {
    const next = await jsonRequest('/api/telegram-viewer'); setPayload(next); setLoadError('');
  }, []);
  const read = useCallback((signal: AbortSignal) => jsonRequest('/api/telegram-viewer', { signal }), []);
  usePoll(read, next => { setPayload(next); setLoadError(''); }, reason => setLoadError(reason.message), 3_000);

  const mutate = useCallback(async (label: string, url: string, init: RequestInit, accepted?: (value: any) => void) => {
    if (readOnly) return;
    setBusy(label);
    setMessage("");
    try {
      const { refreshError } = await mutateAndObserve(() => jsonRequest(url, init), value => { setMessage(`${label}: Antwort bestätigt. Tatsächlichen Dienst-/Versandstatus anschließend beobachten.`); accepted?.(value); }, load);
      if (refreshError) setMessage(`${label}: Antwort bestätigt; Nachladen fehlgeschlagen: ${refreshError}. Kein erneuter Schreibvorgang.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${label} fehlgeschlagen.`);
    } finally {
      setBusy("");
    }
  }, [load, readOnly]);

  const saveSettings = async () => {
    if (!settings || form.conflict) return;
    const users = allowedUsers.split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean);
    const { allowedUsersText: _text, ...storedSettings } = settings;
    await mutate("Einstellungen gespeichert", "/api/telegram-viewer/settings", {
      method: "POST", headers: { "Content-Type": "application/json", ...(form.baseRevision ? { 'If-Match': String(form.baseRevision) } : {}) },
      body: JSON.stringify({ ...storedSettings, allowedUserIds: users }),
    }, result => { if (result.settings) { setPayload((previous: any) => ({ ...previous, ...result })); form.saved({ ...result.settings, allowedUsersText: result.settings.allowedUserIds.join('\n') }, result.settingsRevision ?? null); } });
  };

  const setToken = async () => {
    const token = botToken;
    await mutate("Bot-Token aktualisiert", "/api/telegram-viewer/token", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
    }, () => setBotToken(''));
  };

  const deleteBotToken = async () => {
    if (!await confirm({
      title: "Bot-Token löschen",
      description: "Der Telegram Viewer kann danach keine Nachrichten mehr senden, bis ein neuer Bot-Token gesetzt wurde.",
      confirmLabel: "Bot-Token löschen",
      destructive: true,
    })) return;
    await mutate("Bot-Token gelöscht", "/api/telegram-viewer/token", { method: "DELETE" });
  };

  const rotateServiceToken = async () => {
    if (!await confirm({
      title: "Viewer-Dienst-Token rotieren",
      description: "Der interne Viewer-Dienst erhält einen neuen Zugriffstoken und muss die Verbindung erneuern.",
      confirmLabel: "Dienst-Token rotieren",
      destructive: true,
    })) return;
    await mutate("Dienst-Token rotiert", "/api/telegram-viewer/service-token/rotate", { method: "POST" });
  };

  if (!settings || !payload) return <Empty text={loadError || message || "Telegram Viewer wird geladen …"} />;
  const service = payload.service || {};
  const botConfigured = payload.secrets?.botToken?.configured === true;
  return (
    <div className="operations-stack">
      {confirmationDialog}
      <div className="operations-section-heading">
        <div>
          <h3>Telegram Viewer</h3>
          <p>Separater, ausschließlich lesender Bot ohne Handels-, Konfigurations- oder Börsenzugriff.</p>
        </div>
        <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => void load().catch(reason => setLoadError(reason.message))}><RefreshCw /> Aktualisieren</Button>
      </div>

      {message && <section className="operations-card" aria-live="polite"><p>{message}</p></section>}
      {payload.settingsRecovery?.active && (
        <section className="operations-card critical-dashboard-alert" role="alert">
          <h3>Einstellungen im sicheren Ausgangszustand</h3><p>{payload.settingsRecovery.reason}</p>
        </section>
      )}
      {loadError && <p role="alert">{loadError} · Anzeige möglicherweise veraltet.</p>}
      <DraftState label="Telegram Viewer" form={form} server={serverSettings} />

      <section className="operations-card system-form">
        <h3>Status</h3>
        <div className="operations-metrics">
          <Metric label="Dienst" value={viewerServiceHealth(service)} />
          <Metric label="Bereitschaft" value={service.ready === true ? "bereit" : service.ready === false ? "wartet" : 'unbekannt'} />
          <Metric label="Bot-Token" value={botConfigured ? "konfiguriert" : "fehlt"} />
          <Metric label="Letzte Abfrage" value={time(service.lastPollAt)} />
        </div>
      </section>

      <section className="operations-card system-form">
        <h3>Allgemein</h3>
        <label className="builder-toggle">
          <input aria-label="Viewer aktiv" type="checkbox" checked={settings.enabled}
            onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} />
          <span aria-hidden="true" /> Viewer aktiv
        </label>
        <div className="builder-field-grid">
          <label>Zeitzone<Input value={settings.timezone} onChange={(event) => setSettings({ ...settings, timezone: event.target.value })} /></label>
          <label>Sprache/Locale<Input value={settings.locale} onChange={(event) => setSettings({ ...settings, locale: event.target.value })} /></label>
          <label>Abfrageintervall (ms)<Input aria-label="Abfrageintervall (ms)" type="number" min={1000} max={60000}
            value={settings.eventPollingIntervalMs} onChange={(event) => setSettings({ ...settings, eventPollingIntervalMs: Number(event.target.value) })} /></label>
        </div>
      </section>

      <section className="operations-card system-form">
        <h3>Zugriff</h3>
        <label>Erlaubte Telegram User IDs
          <textarea aria-label="Erlaubte Telegram User IDs" rows={5} value={allowedUsers}
            onChange={(event) => setAllowedUsers(event.target.value)} placeholder="Eine numerische User ID pro Zeile" />
        </label>
      </section>

      <section className="operations-card system-form">
        <h3>Darstellung</h3>
        <div className="builder-field-grid">
          <label>Detailstufe<select value={settings.display.detailLevel}
            onChange={(event) => setSettings({ ...settings, display: { ...settings.display, detailLevel: event.target.value as TelegramViewerSettings["display"]["detailLevel"] } })}>
            <option value="compact">Kompakt</option><option value="normal">Normal</option><option value="detailed">Detailliert</option>
          </select></label>
          <label>PnL-Anzeige<select value={settings.display.pnlMode}
            onChange={(event) => setSettings({ ...settings, display: { ...settings.display, pnlMode: event.target.value as TelegramViewerSettings["display"]["pnlMode"] } })}>
            <option value="absolute">Absolut</option><option value="absolute_and_percent">Absolut und Prozent</option>
          </select></label>
        </div>
        <div className="system-actions"><Button type="button" disabled={Boolean(busy) || form.conflict || readOnly} onClick={() => void saveSettings()}>Einstellungen speichern</Button></div>
      </section>

      <section className="operations-card system-form">
        <h3>Benachrichtigungen</h3>
        <div className="builder-field-grid">
          {TELEGRAM_NOTIFICATION_LABELS.map(([key, label]) => (
            <label className="builder-toggle" key={key}>
              <input type="checkbox" checked={Boolean(settings.notifications[key])}
                onChange={(event) => setSettings({ ...settings, notifications: { ...settings.notifications, [key]: event.target.checked } })} />
              <span aria-hidden="true" /> {label}
            </label>
          ))}
        </div>
      </section>

      <section className="operations-card system-form">
        <h3>Bot-Token</h3>
        <strong>{botConfigured ? "Bot-Token konfiguriert" : "Kein Bot-Token konfiguriert"}</strong>
        <p className="operations-help">Der gespeicherte Wert wird niemals angezeigt.</p>
        <label>Neuer Bot-Token<Input aria-label="Neuer Bot-Token" type="password" autoComplete="off" value={botToken}
          onChange={(event) => setBotToken(event.target.value)} placeholder="123456789:…" /></label>
        <div className="system-actions">
          <Button type="button" disabled={Boolean(busy) || !botToken} onClick={() => void setToken()}>Bot-Token setzen</Button>
          <Button type="button" variant="destructive" disabled={Boolean(busy) || !botConfigured}
            onClick={() => void deleteBotToken()}>Bot-Token löschen</Button>
          <Button type="button" variant="outline" disabled={Boolean(busy)}
            onClick={() => void rotateServiceToken()}>Dienst-Token rotieren</Button>
        </div>
      </section>

      <section className="operations-card system-form">
        <h3>Diagnose</h3>
        <div className="system-line"><span>Erlaubte Benutzer</span><strong>{service.allowedUsers ?? settings.allowedUserIds.length}</strong></div>
        <div className="system-line"><span>Letzter Fehler</span><strong>{service.lastError || "–"}</strong></div>
        <div className="system-line"><span>Letzter Test</span><strong>{service.lastTest ? `${service.lastTest.status} · ${time(service.lastTest.attemptedAt)}` : "–"}</strong></div>
      </section>

      <section className="operations-card system-form">
        <h3>Testnachricht</h3>
        <label>Testnachricht<Input aria-label="Testnachricht" value={testMessage} onChange={(event) => setTestMessage(event.target.value)} /></label>
        <div className="system-actions"><Button type="button" disabled={Boolean(busy) || !testMessage.trim()}
          onClick={() => void mutate("Test angenommen", "/api/telegram-viewer/test", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: testMessage }),
          })}>Test senden</Button></div>
      </section>
    </div>
  );
}
