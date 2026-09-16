import { Metric, Empty, time } from "@/shared/components/operator-primitives";
import { useCallback, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { jsonRequest, mutateAndObserve } from "@/lib/api";
import { portfolioTotal as portfolioSnapshotTotal } from "@/features/accounts/portfolio-total";
import { EvidenceFields } from "@/shared/components/evidence";
import { Link } from "@/lib/navigation";
import { useConfirmationDialog } from "@/components/confirmation-dialog";
import { Button } from "@/components/ui/button";
import type { TradingSnapshot } from "@/app/workflow/types";
import { fallbackPolicyShortLabel } from "@/app/workflow/workflow-fallback-policy";
import { MoneyAmount } from "@/app/workflow/money-amount";
import { usePoll } from "@/shared/api/use-poll";
import { useOperatorReadOnly } from "@/shared/api/operator-session";
import { resolveDisplayedLeverage } from '@/features/trades/plan-display';
import { EquityChart } from '@/features/risk-analytics/equity-chart';
import { OperatorAttention } from './attention';

type SystemStatus = { connectionState?: string; queue?: { running?: number; queued?: number } };
type Operations = { startup?: { phase?: string }; protectionScanComplete?: boolean; backup?: { healthy?: unknown } | null; audit?: { healthy?: unknown } | null };
type PortfolioAccount = Record<string, unknown> & { accountId: string; name?: string; exchange?: string; mode?: string; error?: string | null; equity?: string | null; reportingCurrency?: string | null; observedAt?: number | null };
type Portfolio = { accounts?: PortfolioAccount[]; observedAt?: number; cached?: boolean };
type Access = { identity?: { name?: string; login?: string } | null; actorId?: string; role?: string; remoteAccess?: { connected?: boolean; provider?: string | null } };
type Signal = { id: string | number; channel_id?: string | null; channelId?: string | null; created_at?: number | null; createdAt?: number | null; template_name?: string | null; templateName?: string | null; status?: string | null };
type Intent = { id: string; accountId: string; channelId: string; symbol?: string; side?: string; status: string; plan?: { markPrice?: string; leverage?: unknown; leverageDecision?: { effective?: unknown } | null } | null };
type Order = { id: string; intentId: string; symbol?: string; status: string; role?: string; triggerPrice?: string | null; price?: string | null };
type Position = { id: string; intentId: string; accountId: string; symbol: string; side: string; status: string; averageEntryPrice?: string | null; stopPrice?: string | null; quantity?: string; protection?: { protected?: boolean; reason?: string; evaluatedAt?: number | null } | null; realizedPnlValue?: unknown; realizedPnl?: unknown; reportingCurrency?: unknown; accountingStatus?: unknown };
type PaperMarket = { accountId: string; symbol: string; markPrice?: string; updatedAt?: number };
type RiskEvent = { id: string; severity: string; code: string; accountId?: string | null; createdAt: number };

type CockpitSnapshot = Omit<TradingSnapshot, 'activity'> & { activity: Omit<TradingSnapshot['activity'], 'riskEvents'> & { riskEvents: RiskEvent[] } };

function overviewGates(runtime: TradingSnapshot['overview']['runtime'] | undefined, systemStatus: SystemStatus | null) {
  const liveStatus = () => {
    if (!runtime) {
      return 'unbekannt';
    }
    if (runtime.liveTradingEnabled) {
      return "freigegeben";
    }
    return "gesperrt";
  };
  const killSwitchStatus = () => {
    if (!runtime) {
      return 'unbekannt';
    }
    if (runtime.killSwitchActive) {
      return runtime.killSwitchReason || "aktiv";
    }
    return "frei";
  };
  const entryStatus = () => {
    if (!runtime) {
      return 'unbekannt';
    }
    if (runtime.executionEnabled) {
      return "Einträge aktiv";
    }
    return "Einträge pausiert";
  };
  return [
    [
      "Telegram",
      systemStatus?.connectionState === "connected",
      systemStatus?.connectionState || "unbekannt",
    ],
    [
      "Execution",
      runtime?.executionEnabled === true,
      entryStatus(),
    ],
    [
      "Globaler Kill-Switch",
      runtime?.killSwitchActive === false,
      killSwitchStatus(),
    ],
    [
      "Live-Handel",
      runtime?.liveTradingEnabled === true,
      liveStatus(),
    ],
  ] as const;
}

function ServiceEvidence({ operations, observations, portfolio, systemStatus }: Readonly<{
  operations: Operations | null; observations: Record<string, number>; portfolio: Portfolio | null; systemStatus: SystemStatus | null;
}>) {
  const backupEvidence = () => {
    if (operations?.backup?.healthy === true) {
      return 'Scheduler meldet gesund; Artefakt separat prüfen';
    }
    if (operations?.backup?.healthy === false) {
      return 'gestört';
    }
    return null;
  };
  const auditEvidence = () => {
    if (operations?.audit?.healthy === true) {
      return 'belegt';
    }
    if (operations?.audit?.healthy === false) {
      return 'gestört';
    }
    return null;
  };
  return <section className="operations-card"><h2>Dienst, Schutz und Nachweisalter</h2><EvidenceFields fields={[
    ['Startup', operations?.startup?.phase], ['Initialer Schutzscan abgeschlossen', operations?.protectionScanComplete], ['Audit', auditEvidence()],
    ['Backup', backupEvidence()], ['Betriebsquelle abgerufen', observations['/api/operations'] ? time(observations['/api/operations']) : null],
        ['Portfolio beobachtet', portfolio?.observedAt ? time(portfolio.observedAt) : null], ['Portfolio aus Servercache', portfolio?.cached], ['Queue läuft / wartet', systemStatus?.queue ? `${systemStatus.queue.running ?? 'unbekannt'} / ${systemStatus.queue.queued ?? 'unbekannt'}` : null],
      ]} /><p>Initialer Schutzscan und Dienstgesundheit ersetzen keinen aktuellen kontobezogenen Stop- und REST-Nachweis.</p><Link to="/trading/accounts">Konten & Schutz prüfen</Link> · <Link to="/trading/incidents">Blocker & Incidents</Link> · <Link to="/trading/operations">Ungeklärte Börsenoperationen</Link> · <Link to="/operations/backups">Backup-Nachweise</Link></section>;
}

export function Overview({
  trading,
  systemStatus,
  onRefresh,
  onOpenIncidents,
}: Readonly<{
  trading: TradingSnapshot | null;
  systemStatus: SystemStatus | null;
  onRefresh: () => void | Promise<void>;
  onOpenIncidents?: () => void;
}>) {
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const { confirm, confirmationDialog } = useConfirmationDialog();
  const readOnly = useOperatorReadOnly();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [signals, setSignals] = useState<Signal[] | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});
  const [observations, setObservations] = useState<Record<string, number>>({});
  const [operations, setOperations] = useState<Operations | null>(null);
  const readDashboard = useCallback((signal: AbortSignal) => {
    return Promise.all(['/api/trading/portfolio', '/api/processed-signals', '/api/access', '/api/operations'].map(async source => {
      try { return { source, value: await jsonRequest(source, { signal }), error: '', observedAt: Date.now() }; }
      catch (reason) { return { source, value: null, error: reason instanceof Error ? reason.message : String(reason), observedAt: null }; }
    }));
  }, []);
  usePoll(readDashboard, results => { for (const result of results) {
    setSourceErrors(previous => ({ ...previous, [result.source]: result.error }));
    if (result.error || result.observedAt === null) continue;
    setObservations(previous => ({ ...previous, [result.source]: result.observedAt }));
    if (result.source === '/api/trading/portfolio') setPortfolio(result.value);
    if (result.source === '/api/processed-signals') setSignals(result.value.signals ?? []);
    if (result.source === '/api/access') setAccess(result.value);
    if (result.source === '/api/operations') setOperations(result.value.operations ?? null);
  } }, reason => setMessage(reason.message));
  const overview = trading?.overview;
  const runtime = overview?.runtime;
  const gates = overviewGates(runtime, systemStatus);
  const portfolioTotal = (key: string) => portfolioSnapshotTotal(portfolio?.accounts, key);
  const openPositions = ((trading?.activity.positions as Position[] | undefined) || []).filter((position) => ["opening", "open", "closing", "emergency"].includes(position.status));
  const intentById = new Map(((trading?.intents as Intent[] | undefined) || []).map((intent) => [intent.id, intent]));
  const accountById = new Map((trading?.accounts || []).map((account) => [account.id, account]));
  const openIncidents = (trading?.accountIncidents || []).filter((incident) => incident.status === "open");
  const mutate = async (key: string, url: string, body: unknown) => {
    if (readOnly) return;
    setBusy(key);
    setMessage("");
    try {
      const { refreshError } = await mutateAndObserve(() => jsonRequest(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }), () => setMessage('Command bestätigt. Tatsächliche Kontozustände, offene Operationen und Schutzbelege jetzt prüfen; Freigabe ist kein gestarteter Trade.'), onRefresh);
      if (refreshError) setMessage(`Command bestätigt; Nachladen fehlgeschlagen: ${refreshError}. Anzeige möglicherweise veraltet.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };
  const setLive = async () => {
    const enabled = runtime?.liveTradingEnabled !== true;
    if (enabled && !await confirm({
      title: "Live-Handel freigeben",
      description: "Orders dürfen danach an live geschaltete Börsenkonten gesendet werden.",
      confirmationText: "ENABLE LIVE TRADING",
      confirmLabel: "Live freigeben",
      destructive: true,
    })) return;
    await mutate("live", "/api/trading/runtime", {
      action: "live",
      enabled,
      ...(enabled ? { confirmation: "ENABLE LIVE TRADING" } : {}),
    });
  };
  const setKillSwitch = async () => {
    const active = runtime?.killSwitchActive !== true;
    if (active) {
      const reason = await confirm({
        title: "Globalen Kill-Switch aktivieren",
        description: "Neue Handelsaktivität wird systemweit gesperrt.",
        inputLabel: "Grund für die globale Handelssperre",
        inputRequired: true,
        confirmLabel: "Kill-Switch aktivieren",
        destructive: true,
      });
      if (!reason) return;
      await mutate("kill", "/api/trading/runtime", {
        action: "kill-switch",
        active: true,
        reason,
      });
    } else {
      if (!await confirm({
        title: "Globale Sperre lösen",
        description: "Konten, Orders und Stop-Schutz werden frisch geprüft. Einzelne Kontosperren bleiben bestehen; die Ausführung startet nicht automatisch.",
        confirmationText: "RELEASE GLOBAL KILL SWITCH",
        confirmLabel: "Sperre prüfen & lösen",
        destructive: true,
      })) return;
      await mutate("kill", "/api/trading/runtime", {
        action: "kill-switch",
        active: false,
        confirmation: "RELEASE GLOBAL KILL SWITCH",
      });
    }
  };
  const emergencyFlatten = async () => {
    if (!await confirm({
      title: "Verwaltete Positionen schließen",
      description: "Alle von TSX Core verwalteten Positionen werden als Notfallmaßnahme geschlossen.",
      confirmationText: "FLATTEN MANAGED POSITIONS",
      confirmLabel: "Positionen schließen",
      destructive: true,
    })) return;
    await mutate("flatten", "/api/trading/emergency-flatten", {
      confirmation: "FLATTEN MANAGED POSITIONS",
    });
  };
  const remoteAccessStatus = () => {
    if (access?.remoteAccess?.connected === true) {
      return `${access.remoteAccess.provider} verbunden`;
    }
    if (access?.remoteAccess?.connected === false) {
      return "nicht verbunden";
    }
    return "unbekannt";
  };
   const dashboardGrid = (
      <div className="dashboard-grid">
        <section className="operations-card analytics-chart dashboard-equity-card">
          <h3>Equity-Verlauf</h3>
          <EquityChart
            points={trading?.equityHistory || []}
            accounts={trading?.accounts || []}
            emptyText="Noch keine Equity-Messwerte."
          />
        </section>
        <section className="operations-card">
          <h3>Remote-Zugriff und Betrieb</h3>
          <div className="system-line"><span>Identität</span><strong>{access?.identity?.name || access?.identity?.login || access?.actorId || "unbekannt"}</strong></div>
          <div className="system-line"><span>Rolle</span><strong>{access?.role || "–"}</strong></div>
          <div className="system-line"><span>Remote-Zugriff</span><strong>{remoteAccessStatus()}</strong></div>
          <div className="system-line"><span>Letzter Abgleich</span><strong>{time(overview?.latestReconciliationAt)}</strong></div>
          {(portfolio?.accounts || []).map((account) => <div className="system-line" key={account.accountId}><span>{account.name} · {account.exchange}/{account.mode}</span><strong>{account.error || `${account.equity ?? "unbekannt"} ${account.reportingCurrency ?? ""} · ${time(account.observedAt)}`}</strong></div>)}
        </section>
      </div>
   );
   const positionsSection = (
      <section className="operations-card">
        <h3>Aktive Positionen · aktueller Ausschnitt</h3>
        <p>{trading?.interpretation} <Link to="/trading/positions">Alle Positionen seitenweise lesen</Link> · <Link to="/trading/orders?status=unknown">Alle unklaren Orders</Link> · <Link to="/trading/journal">Alle Intents im Journal</Link></p>
        {trading?.coverage && Object.values(trading.coverage).some(Boolean) && <p>Mindestens eine Quelle enthält weitere Daten. Die Listenlinks öffnen die vollständige Seitenauswahl. Equity zeigt höchstens 1.000 Originalbeobachtungen ab dem 90-Tage-Fensterbeginn.</p>}
        <div className="position-table" role="table" aria-label="Aktive Positionen">
          <div className="position-row heading" role="row"><span role="columnheader">Position</span><span role="columnheader">Fill-Durchschnitt / Paper-Mark</span><span role="columnheader">SL (gemeldet)</span><span role="columnheader">TPs</span><span role="columnheader">Hebel</span><span role="columnheader">Realisierter PnL</span></div>
          {openPositions.map((position) => {
            const intent = intentById.get(position.intentId);
            const orders = (trading?.activity.orders as Order[] | undefined) || [];
            const relatedOrders = orders.filter((order) => order.intentId === position.intentId);
            const targets = relatedOrders.filter((order) => String(order.role).startsWith("take_profit")).map((order) => order.triggerPrice || order.price);
            const paperMarket = (trading?.activity.paperMarkets as PaperMarket[] | undefined)?.find((market) => market.accountId === position.accountId && market.symbol === position.symbol);
            const leverage = resolveDisplayedLeverage(intent?.plan);
            return <div className="position-row" role="row" key={position.id}>
              <strong role="cell"><Link to={`/trading/trades/${encodeURIComponent(position.intentId)}`}>{position.symbol} · {position.side}</Link><small>{accountById.get(position.accountId)?.name || position.accountId}</small></strong>
              <span role="cell">{position.averageEntryPrice ?? "unbekannt"} / {paperMarket?.markPrice ?? "nicht verfügbar"}<small>Planreferenz: {intent?.plan?.markPrice ?? "unbekannt"} · Mark beobachtet: {time(paperMarket?.updatedAt)} · Unrealisierter PnL: nicht verfügbar</small></span>
              <span role="cell">{position.stopPrice || relatedOrders.find((order) => order.role === "stop_loss")?.triggerPrice || "unbekannt"}<small>Restmenge {position.quantity ?? 'unbekannt'} · Schutz: {position.protection?.protected === true ? 'aktuell belegt' : 'nicht aktuell bewiesen'} · {position.protection?.reason ?? 'Originalbeleg im Trade-Detail'}. Prüfung {time(position.protection?.evaluatedAt)}.</small></span>
              <span role="cell">{targets.length ? targets.join(" · ") : 'keine Orderbelege im Ausschnitt'}</span>
              <span role="cell">{leverage ? `${leverage}×` : "unbekannt"}</span>
              <span role="cell"><MoneyAmount value={position.realizedPnlValue} amount={position.realizedPnl} currency={position.reportingCurrency} status={position.accountingStatus} /></span>
            </div>;
          })}
          {trading && openPositions.length === 0 && <Empty text="Keine aktive Position." />}
        </div>
      </section>
   );
   return (
    <div className="operations-stack">
      {confirmationDialog}
      {message && <output className="builder-info">{message}</output>}
      <OperatorAttention />
      {Object.entries(sourceErrors).filter(([, error]) => error).map(([source, error]) => <p key={source} role="alert">{source}: {error} · Quelle möglicherweise veraltet; andere Nachweise bleiben separat verfügbar.</p>)}
      <ServiceEvidence operations={operations} observations={observations} portfolio={portfolio} systemStatus={systemStatus} />
      {openIncidents.length > 0 && (
        <section className="operations-card critical-dashboard-alert" aria-live="assertive">
          <AlertTriangle />
          <div>
            <h3>{openIncidents.length} aktive Konto-Incident{openIncidents.length === 1 ? "" : "s"}</h3>
            {openIncidents.slice(0, 3).map((incident) => <p key={incident.id}>{accountById.get(incident.accountId)?.name || incident.accountId}: {incident.message} · {incident.occurrenceCount}×</p>)}
            {onOpenIncidents && (
              <Button type="button" variant="outline" size="sm" onClick={onOpenIncidents}>
                Incidents prüfen
              </Button>
            )}
          </div>
        </section>
      )}
      <div className="operations-metrics portfolio-metrics">
        <Metric label="Portfolio-Eigenkapital" value={portfolioTotal("equity")} />
        <Metric label="Verfügbares Kapital" value={portfolioTotal("availableBalance")} />
        <Metric label="Gebundene Margin" value={portfolioTotal("marginUsed")} />
        <Metric label="Unrealisierter PnL" value={portfolioTotal("unrealizedPnl")} />
      </div>
      <div className="operations-metrics">
        <div className="operation-metric">
          <strong>{overview?.enabledRouteCount ?? "unbekannt"}</strong><span>Aktive Pfade</span>
        </div>
        <div className={`operation-metric ${((overview?.unknownOrderCount ?? 0) > 0 ? "danger" : "")}`}>
          <strong>{overview?.openPositionCount ?? "unbekannt"}</strong><span>Offene Positionen</span>
          {openPositions.slice(0, 5).map((p) => (
            <small key={p.id} style={{ display: "block", marginTop: 4 }}>{p.symbol} · {p.side} — {p.status}</small>
          ))}
          {trading && openPositions.length === 0 && <small style={{ color: "var(--muted-foreground)" }}>Keine Position</small>}
        </div>
        <div className="operation-metric">
          <strong>{overview?.pendingIntentCount ?? "unbekannt"}</strong><span>Wartende Intents</span>
          {trading && ((trading?.intents as Intent[] | undefined) || []).filter((i) => ["pending","planned","submitting"].includes(i.status)).slice(0,5).map((i) => (
            <small key={i.id} style={{ display: "block", marginTop: 4 }}>{i.symbol || i.channelId} · {i.status}</small>
          ))}
          {trading && ((trading?.intents as Intent[] | undefined) || []).filter((i) => ["pending","planned","submitting"].includes(i.status)).length === 0 && <small style={{ color: "var(--muted-foreground)" }}>Keine Intents</small>}
        </div>
        <div className={`operation-metric ${((overview?.unknownOrderCount ?? 0) > 0 ? "danger" : "")}`}>
          <strong>{overview?.unknownOrderCount ?? "unbekannt"}</strong><span>Unklare Orders</span>
          {trading && ((trading?.activity.orders as Order[] | undefined) || []).filter((o) => o.status === "unknown").slice(0,5).map((o) => (
            <small key={o.id} style={{ display: "block", marginTop: 4 }}>{o.symbol || o.intentId} · {o.status}</small>
          ))}
          {trading && ((trading?.activity.orders as Order[] | undefined) || []).filter((o) => o.status === "unknown").length === 0 && <small style={{ color: "var(--muted-foreground)" }}>Keine unklaren Orders</small>}
        </div>
      </div>
      <section className="operations-card">
        <h3>Entscheidende Live-Gates</h3>
        {gates.map(([label, healthy, detail]) => (
          <div className="gate-row" key={label}>
            <span className={`status-dot ${healthy ? "healthy" : "muted"}`} />
            <strong>{label}</strong>
            <span>{detail}</span>
          </div>
        ))}
      </section>
      {dashboardGrid}
      {positionsSection}
      <div className="dashboard-grid">
        <section className="operations-card">
          <h3>Aktuelle Signale</h3>
          {(signals ?? []).slice(0, 5).map((signal) => <div className="adaptive-row" key={signal.id}><div><strong>{signal.channel_id || signal.channelId || "Kanal"}</strong><small>{time(signal.created_at || signal.createdAt)} · {signal.template_name || signal.templateName || "Signal"}</small></div><span className="state-badge">{signal.status || "verarbeitet"}</span></div>)}
          {signals?.length === 0 && <Empty text="Noch keine verarbeiteten Signale." />}
        </section>
        <section className="operations-card">
          <h3>Offene Intents</h3>
          {((trading?.intents as Intent[] | undefined) || []).filter((intent) => ["pending", "planned", "submitting", "monitoring", "unknown"].includes(intent.status)).slice(0, 5).map((intent) => <div className="adaptive-row" key={intent.id}><div><strong>{intent.symbol} · {intent.side}</strong><small>{intent.channelId} → {accountById.get(intent.accountId)?.name || intent.accountId}</small></div><span className={`state-badge ${intent.status === "unknown" ? "danger" : ""}`}>{intent.status}</span></div>)}
          {trading && !((trading?.intents as Intent[] | undefined) || []).some((intent) => ["pending", "planned", "submitting", "monitoring", "unknown"].includes(intent.status)) && <Empty text="Keine offenen Intents." />}
        </section>
      </div>
      <section className="operations-card">
        <h3>Letzte Börsen-Fallbacks</h3>
        {(trading?.fallbackRuns || []).slice(0, 8).map((run) => {
          const fallbackStatus = () => {
            if (run.status === "probing") {
              return "wird geprüft";
            }
            if (run.status === "selected") {
              return "Konto gewählt";
            }
            if (run.status === "exhausted") {
              return `Kette ausgeschöpft: ${run.stopReason || "kein Kandidat"}`;
            }
            return `gestoppt: ${run.stopReason || "Schutzregel"}`;
          };
          const fallbackBadge = () => {
            if (run.status === "exhausted" || run.status === "stopped") {
              return "danger";
            }
            if (run.status === "selected") {
              return "healthy";
            }
            return "";
          };
          return ((
            <div className="adaptive-row" key={run.id}>
              <div>
                <strong>{run.channelName || run.channelId}</strong><Link to={`/signals/processed/${encodeURIComponent(run.sourceSignalId)}`}>Ursprüngliches Signal und Eingangsspur</Link>
                <small>
                  {run.candidates.map((candidate) => {
                    const policy = candidate.fallbackOn.length
                      ? fallbackPolicyShortLabel(candidate.fallbackOn)
                      : "Ende der Kette";
                    const reason = candidate.errorCode ? ` · ${candidate.errorCode}` : "";
                    return `${candidate.rank + 1}. ${candidate.accountName} (${candidate.status}${reason}) · ${policy}`;
                  }).join(" → ")}
                </small>
              </div>
              <span className={`state-badge ${fallbackBadge()}`}>
                {fallbackStatus()}
              </span>
            </div>
          ));
        })}
        {trading && !(trading?.fallbackRuns || []).length && (
          <Empty text="Im aktuellen Ausschnitt sind keine Börsen-Fallbacks enthalten." />
        )}
      </section>
      <section className="operations-card">
        <h3>Handelssteuerung</h3>
        <div className="system-actions">
          <button
            type="button"
            className="primary-button"
            disabled={Boolean(busy) || readOnly || !runtime}
            onClick={() =>
              { mutate("execution", "/api/trading/runtime", {
                action: "execution",
                enabled: runtime?.executionEnabled !== true,
              }); }
            }
          >
            {runtime?.executionEnabled
              ? "Neue Entries pausieren"
              : "Ausführung abgleichen & starten"}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={Boolean(busy) || readOnly || !runtime}
            onClick={() => { setLive(); }}
          >
            {runtime?.liveTradingEnabled ? "Live sperren" : "Live freigeben"}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={Boolean(busy) || readOnly || !runtime}
            onClick={() => { setKillSwitch(); }}
          >
            {runtime?.killSwitchActive
              ? "Sperre prüfen & lösen"
              : "Kill-Switch aktivieren"}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={Boolean(busy) || readOnly || !runtime}
            onClick={() =>
              { mutate("reconcile", "/api/trading/reconcile", {}); }
            }
          >
            Alle Konten abgleichen
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={Boolean(busy) || readOnly || !runtime}
            onClick={() =>
              { mutate("cancel", "/api/trading/cancel-entries", {}); }
            }
          >
            Offene Entries stornieren
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={Boolean(busy) || readOnly || !runtime}
            onClick={() => { emergencyFlatten(); }}
          >
            Notfall: Positionen schließen
          </button>
        </div>
      </section>
      <section className="operations-card">
        <h3>Letzte Risikoereignisse</h3>
        {(trading as CockpitSnapshot | null)?.activity.riskEvents.slice(0, 8).map((event) => (
          <div className="event-row" key={event.id}>
            <span className={`severity ${event.severity}`}>
              {event.severity}
            </span>
            <div>
              <strong>{event.code}</strong>
              <small>
                {event.accountId || "global"} · {time(event.createdAt)}
              </small>
            </div>
          </div>
        ))}
        {!trading?.activity.riskEvents.length && (
          <Empty text="Keine Risikoereignisse." />
        )}
      </section>
    </div>
  );
}
