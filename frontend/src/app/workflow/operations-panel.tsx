import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  Check,
  DatabaseBackup,
  Gauge,
  Landmark,
  Plus,
  RefreshCw,
  ServerCog,
  Terminal,
} from "lucide-react";
import { apiFetch, clearDashboardToken, jsonRequest, setDashboardToken } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ExchangeCatalog, TradingAccount, TradingSnapshot } from "./types";

export type OperationTab =
  | "overview"
  | "accounts"
  | "journal"
  | "analytics"
  | "logs"
  | "backups"
  | "mcp"
  | "system";

const TABS: Array<{ id: OperationTab; label: string; description: string; icon: typeof Activity }> =
  [
    { id: "overview", label: "Live", description: "Gates und Laufzeit", icon: Activity },
    { id: "accounts", label: "Konten", description: "Börsen und Schutz", icon: Landmark },
    { id: "journal", label: "Journal", description: "Trades und Prüfung", icon: Gauge },
    { id: "analytics", label: "Analyse", description: "Leistung und Latenz", icon: BarChart3 },
    { id: "logs", label: "Logs", description: "Live-Diagnose", icon: Terminal },
    { id: "backups", label: "Backups", description: "Sicherung und Restore", icon: DatabaseBackup },
    { id: "mcp", label: "MCP", description: "Agenten und Rechte", icon: Bot },
    { id: "system", label: "System", description: "Zugriff und Wartung", icon: ServerCog },
  ];

const OPERATION_TABS = new Map(TABS.map((tab) => [tab.id, tab]));

function time(value: unknown): string {
  return typeof value === "number" && value > 0
    ? new Date(value).toLocaleString("de-DE")
    : "–";
}

function Overview({
  trading,
  systemStatus,
  onRefresh,
}: {
  trading: TradingSnapshot | null;
  systemStatus: Record<string, any> | null;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [portfolio, setPortfolio] = useState<any>({ accounts: [] });
  const [signals, setSignals] = useState<any[]>([]);
  const [access, setAccess] = useState<any>(null);
  const dashboardInFlight = useRef(false);
  const refreshDashboard = useCallback(async () => {
    if (dashboardInFlight.current) return;
    dashboardInFlight.current = true;
    try {
      const [portfolioPayload, signalPayload, accessPayload] = await Promise.all([
        jsonRequest("/api/trading/portfolio"),
        jsonRequest("/api/processed-signals"),
        jsonRequest("/api/access"),
      ]);
      setPortfolio(portfolioPayload);
      setSignals(signalPayload.signals || []);
      setAccess(accessPayload);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      dashboardInFlight.current = false;
    }
  }, []);
  useEffect(() => {
    void refreshDashboard();
    const timer = window.setInterval(() => void refreshDashboard(), 5_000);
    return () => window.clearInterval(timer);
  }, [refreshDashboard]);
  const overview = trading?.overview;
  const runtime = overview?.runtime;
  const gates = [
    [
      "Telegram",
      systemStatus?.connectionState === "connected",
      systemStatus?.connectionState || "unbekannt",
    ],
    [
      "Execution",
      runtime?.executionEnabled === true,
      runtime?.executionEnabled ? "Einträge aktiv" : "Einträge pausiert",
    ],
    [
      "Globaler Kill-Switch",
      runtime?.killSwitchActive !== true,
      runtime?.killSwitchActive ? runtime.killSwitchReason || "aktiv" : "frei",
    ],
    [
      "Live-Handel",
      runtime?.liveTradingEnabled === true,
      runtime?.liveTradingEnabled ? "freigegeben" : "gesperrt",
    ],
  ] as const;
  const portfolioTotal = (key: string) => {
    const totals = new Map<string, number>();
    for (const account of portfolio.accounts || []) {
      const value = Number(account[key]);
      if (!Number.isFinite(value)) continue;
      const currency = String(account.reportingCurrency || "QUOTE");
      totals.set(currency, (totals.get(currency) || 0) + value);
    }
    return [...totals.entries()].map(([currency, value]) => `${metricNumber(value)} ${currency}`).join(" · ") || "–";
  };
  const openPositions = (trading?.activity.positions || []).filter((position: any) => ["opening", "open", "closing", "emergency"].includes(position.status));
  const intentById = new Map((trading?.intents || []).map((intent: any) => [intent.id, intent]));
  const accountById = new Map((trading?.accounts || []).map((account) => [account.id, account]));
  const openIncidents = (trading?.accountIncidents || []).filter((incident) => incident.status === "open");
  const mutate = async (key: string, url: string, body: unknown) => {
    setBusy(key);
    setMessage("");
    try {
      await jsonRequest(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };
  const setLive = async () => {
    const enabled = runtime?.liveTradingEnabled !== true;
    if (
      enabled &&
      window.prompt(
        "Live-Handel freigeben. ENABLE LIVE TRADING exakt eingeben:",
      ) !== "ENABLE LIVE TRADING"
    )
      return;
    await mutate("live", "/api/trading/runtime", {
      action: "live",
      enabled,
      ...(enabled ? { confirmation: "ENABLE LIVE TRADING" } : {}),
    });
  };
  const setKillSwitch = async () => {
    const active = runtime?.killSwitchActive !== true;
    if (active) {
      const reason = window
        .prompt("Grund für die globale Handelssperre:")
        ?.trim();
      if (!reason) return;
      await mutate("kill", "/api/trading/runtime", {
        action: "kill-switch",
        active: true,
        reason,
      });
    } else {
      if (
        !window.confirm(
          "Globale Sperre erst nach vollständigem Börsenabgleich aufheben?",
        )
      )
        return;
      await mutate("kill", "/api/trading/runtime", {
        action: "kill-switch",
        active: false,
      });
    }
  };
  const emergencyFlatten = async () => {
    if (
      window.prompt(
        "Alle von TSX Core verwalteten Positionen schließen. FLATTEN MANAGED POSITIONS exakt eingeben:",
      ) !== "FLATTEN MANAGED POSITIONS"
    )
      return;
    await mutate("flatten", "/api/trading/emergency-flatten", {
      confirmation: "FLATTEN MANAGED POSITIONS",
    });
  };
   return (
    <div className="operations-stack">
      {message && <div className="builder-error">{message}</div>}
      {openIncidents.length > 0 && (
        <section className="operations-card critical-dashboard-alert" aria-live="assertive">
          <AlertTriangle />
          <div>
            <h3>{openIncidents.length} aktive Konto-Incident{openIncidents.length === 1 ? "" : "s"}</h3>
            {openIncidents.slice(0, 3).map((incident) => <p key={incident.id}>{accountById.get(incident.accountId)?.name || incident.accountId}: {incident.message} · {incident.occurrenceCount}×</p>)}
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
          <strong>{overview?.enabledRouteCount ?? 0}</strong><span>Aktive Pfade</span>
        </div>
        <div className={`operation-metric ${((overview?.unknownOrderCount ?? 0) > 0 ? "danger" : "")}`}>
          <strong>{overview?.openPositionCount ?? 0}</strong><span>Offene Positionen</span>
          {openPositions.slice(0, 5).map((p: any) => (
            <small key={p.id} style={{ display: "block", marginTop: 4 }}>{p.symbol} · {p.side} — {p.status}</small>
          ))}
          {openPositions.length === 0 && <small style={{ color: "var(--muted-foreground)" }}>Keine Position</small>}
        </div>
        <div className="operation-metric">
          <strong>{overview?.pendingIntentCount ?? 0}</strong><span>Wartende Intents</span>
          {(trading?.intents || []).filter((i: any) => ["pending","planned","submitting"].includes(i.status)).slice(0,5).map((i: any) => (
            <small key={i.id} style={{ display: "block", marginTop: 4 }}>{i.symbol || i.channelId} · {i.status}</small>
          ))}
          {(trading?.intents || []).filter((i: any) => ["pending","planned","submitting"].includes(i.status)).length === 0 && <small style={{ color: "var(--muted-foreground)" }}>Keine Intents</small>}
        </div>
        <div className={`operation-metric ${((overview?.unknownOrderCount ?? 0) > 0 ? "danger" : "")}`}>
          <strong>{overview?.unknownOrderCount ?? 0}</strong><span>Unklare Orders</span>
          {(trading?.activity.orders || []).filter((o: any) => o.status === "unknown").slice(0,5).map((o: any) => (
            <small key={o.id} style={{ display: "block", marginTop: 4 }}>{o.symbol || o.intentId} · {o.status}</small>
          ))}
          {(trading?.activity.orders || []).filter((o: any) => o.status === "unknown").length === 0 && <small style={{ color: "var(--muted-foreground)" }}>Keine unklaren Orders</small>}
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
      <div className="dashboard-grid">
        <section className="operations-card analytics-chart dashboard-equity-card">
          <h3>Equity-Verlauf</h3>
          {(trading?.equityHistory || []).length ? (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={trading?.equityHistory || []}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="observedAt" tickFormatter={(value) => new Date(value).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} minTickGap={24} />
                <YAxis width={62} domain={["auto", "auto"]} />
                <Tooltip labelFormatter={(value) => time(value)} formatter={(value) => metricNumber(value)} />
                <Line type="monotone" dataKey="equity" dot={false} stroke="var(--chart-1)" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          ) : <Empty text="Noch keine Equity-Messwerte." />}
        </section>
        <section className="operations-card">
          <h3>Remote-Zugriff und Betrieb</h3>
          <div className="system-line"><span>Identität</span><strong>{access?.identity?.name || access?.identity?.login || access?.actorId || "unbekannt"}</strong></div>
          <div className="system-line"><span>Rolle</span><strong>{access?.role || "–"}</strong></div>
          <div className="system-line"><span>Remote-Zugriff</span><strong>{access?.remoteAccess?.connected ? `${access.remoteAccess.provider} verbunden` : "nicht verbunden"}</strong></div>
          <div className="system-line"><span>Letzter Abgleich</span><strong>{time(overview?.latestReconciliationAt)}</strong></div>
          {(portfolio.accounts || []).map((account: any) => <div className="system-line" key={account.accountId}><span>{account.name} · {account.exchange}/{account.mode}</span><strong>{account.error || `${metricNumber(account.equity)} ${account.reportingCurrency}`}</strong></div>)}
        </section>
      </div>
      <section className="operations-card">
        <h3>Aktive Positionen</h3>
        <div className="position-table" role="table" aria-label="Aktive Positionen">
          <div className="position-row heading" role="row"><span>Position</span><span>Entry / Mark</span><span>SL</span><span>TPs</span><span>Hebel</span><span>PnL</span></div>
          {openPositions.map((position: any) => {
            const intent: any = intentById.get(position.intentId);
            const orders = trading?.activity.orders || [];
            const relatedOrders = orders.filter((order: any) => order.intentId === position.intentId);
            const targets = relatedOrders.filter((order: any) => String(order.role).startsWith("take_profit")).map((order: any) => order.triggerPrice || order.price);
            const paperMarket = trading?.activity.paperMarkets?.find((market: any) => market.accountId === position.accountId && market.symbol === position.symbol);
            return <div className="position-row" role="row" key={position.id}>
              <strong>{position.symbol} · {position.side}<small>{accountById.get(position.accountId)?.name || position.accountId}</small></strong>
              <span>{position.averageEntryPrice || "–"} / {paperMarket?.markPrice || intent?.plan?.markPrice || "–"}</span>
              <span>{position.stopPrice || relatedOrders.find((order: any) => order.role === "stop_loss")?.triggerPrice || "–"}</span>
              <span>{targets.length ? targets.join(" · ") : intent?.signal?.targets?.map((target: any) => target.min ?? target).join(" · ") || "–"}</span>
              <span>{intent?.plan?.leverage ? `${intent.plan.leverage}×` : "–"}</span>
              <span>{position.realizedPnl ?? intent?.plan?.unrealizedPnl ?? "–"}</span>
            </div>;
          })}
          {openPositions.length === 0 && <Empty text="Keine aktive Position." />}
        </div>
      </section>
      <div className="dashboard-grid">
        <section className="operations-card">
          <h3>Aktuelle Signale</h3>
          {signals.slice(0, 5).map((signal: any) => <div className="adaptive-row" key={signal.id}><div><strong>{signal.channel_id || signal.channelId || "Kanal"}</strong><small>{time(signal.created_at || signal.createdAt)} · {signal.template_name || signal.templateName || "Signal"}</small></div><span className="state-badge">{signal.status || "verarbeitet"}</span></div>)}
          {signals.length === 0 && <Empty text="Noch keine verarbeiteten Signale." />}
        </section>
        <section className="operations-card">
          <h3>Offene Intents</h3>
          {(trading?.intents || []).filter((intent: any) => ["pending", "planned", "submitting", "monitoring", "unknown"].includes(intent.status)).slice(0, 5).map((intent: any) => <div className="adaptive-row" key={intent.id}><div><strong>{intent.symbol} · {intent.side}</strong><small>{intent.channelId} → {accountById.get(intent.accountId)?.name || intent.accountId}</small></div><span className={`state-badge ${intent.status === "unknown" ? "danger" : ""}`}>{intent.status}</span></div>)}
          {!(trading?.intents || []).some((intent: any) => ["pending", "planned", "submitting", "monitoring", "unknown"].includes(intent.status)) && <Empty text="Keine offenen Intents." />}
        </section>
      </div>
      <section className="operations-card">
        <h3>Handelssteuerung</h3>
        <div className="system-actions">
          <button
            type="button"
            className="primary-button"
            disabled={Boolean(busy)}
            onClick={() =>
              void mutate("execution", "/api/trading/runtime", {
                action: "execution",
                enabled: runtime?.executionEnabled !== true,
              })
            }
          >
            {runtime?.executionEnabled
              ? "Neue Entries pausieren"
              : "Ausführung abgleichen & starten"}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={Boolean(busy)}
            onClick={() => void setLive()}
          >
            {runtime?.liveTradingEnabled ? "Live sperren" : "Live freigeben"}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={Boolean(busy)}
            onClick={() => void setKillSwitch()}
          >
            {runtime?.killSwitchActive
              ? "Sperre prüfen & lösen"
              : "Kill-Switch aktivieren"}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={Boolean(busy)}
            onClick={() =>
              void mutate("reconcile", "/api/trading/reconcile", {})
            }
          >
            Alle Konten abgleichen
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={Boolean(busy)}
            onClick={() =>
              void mutate("cancel", "/api/trading/cancel-entries", {})
            }
          >
            Offene Entries stornieren
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={Boolean(busy)}
            onClick={() => void emergencyFlatten()}
          >
            Notfall: Positionen schließen
          </button>
        </div>
      </section>
      <section className="operations-card">
        <h3>Letzte Risikoereignisse</h3>
        {trading?.activity.riskEvents.slice(0, 8).map((event: any) => (
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

function Metric({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: number | string;
  danger?: boolean;
}) {
  return (
    <div className={`operation-metric ${danger ? "danger" : ""}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="operations-empty">{text}</div>;
}

function AccountPositionLimit({
  account,
  disabled,
  onSave,
}: {
  account: TradingAccount;
  disabled: boolean;
  onSave: (maximum: number) => Promise<void>;
}) {
  const [maximum, setMaximum] = useState(account.maxConcurrentPositions);
  useEffect(
    () => setMaximum(account.maxConcurrentPositions),
    [account.maxConcurrentPositions],
  );
  const valid = Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= 20;
  return (
    <div className="account-limit-editor">
      <label>
        Positionslimit
        <input
          type="number"
          min={1}
          max={20}
          value={maximum}
          disabled={disabled}
          onChange={(event) => setMaximum(Number(event.target.value))}
        />
      </label>
      <button
        type="button"
        className="secondary-button"
        disabled={
          disabled || !valid || maximum === account.maxConcurrentPositions
        }
        onClick={() => void onSave(maximum)}
      >
        Limit speichern
      </button>
    </div>
  );
}

function Accounts({
  trading,
  catalog,
  onRefresh,
}: {
  trading: TradingSnapshot | null;
  catalog: ExchangeCatalog | null;
  onRefresh: () => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Record<string, any>>({
    name: "",
    exchange: "paper",
    mode: "paper",
    initialBalance: "10000",
    maxConcurrentPositions: 20,
    credentials: {},
  });
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [credentialFor, setCredentialFor] = useState("");
  const [replacement, setReplacement] = useState<Record<string, string>>({});
  const [releaseTarget, setReleaseTarget] = useState<TradingAccount | null>(null);
  const [releaseConfirmation, setReleaseConfirmation] = useState("");
  const exchange = catalog?.exchanges.find((item) => item.id === form.exchange);

  const updateAccount = async (
    account: TradingAccount,
    change: Record<string, unknown>,
  ) => {
    setBusy(account.id);
    setMessage("");
    try {
      await jsonRequest("/api/trading/accounts/configuration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: account.id, ...change }),
      });
      await onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };

  const releaseKillSwitch = async (account: TradingAccount) => {
    setReleaseTarget(account);
    setReleaseConfirmation("");
  };

  const confirmKillSwitchRelease = async () => {
    if (!releaseTarget) return;
    setBusy(releaseTarget.id);
    setMessage("");
    try {
      await jsonRequest("/api/trading/accounts/kill-switch/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: releaseTarget.id,
          confirmation: releaseConfirmation,
        }),
      });
      setReleaseTarget(null);
      setReleaseConfirmation("");
      await onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };

  const accountAction = async (
    account: TradingAccount,
    action: "verify" | "reconcile" | "toggle" | "delete",
  ) => {
    if (
      action === "delete" &&
      window.prompt(
        `Konto „${account.name}“ endgültig entfernen. DELETE eingeben:`,
      ) !== "DELETE"
    )
      return;
    setBusy(account.id);
    setMessage("");
    try {
      const request =
        action === "verify"
          ? ([
              "/api/trading/accounts/verify",
              { id: account.id },
              "POST",
            ] as const)
          : action === "reconcile"
            ? ([
                "/api/trading/reconcile",
                { accountId: account.id },
                "POST",
              ] as const)
            : action === "toggle"
              ? ([
                  "/api/trading/accounts/state",
                  { id: account.id, enabled: !account.enabled },
                  "POST",
                ] as const)
              : ([
                  "/api/trading/accounts",
                  { id: account.id },
                  "DELETE",
                ] as const);
      await jsonRequest(request[0], {
        method: request[2],
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request[1]),
      });
      if (action === "delete") {
        setCredentialFor("");
        setReplacement({});
      }
      await onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };

  const replaceCredentials = async (account: TradingAccount) => {
    setBusy(account.id);
    setMessage("");
    try {
      await jsonRequest("/api/trading/accounts/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: account.id, credentials: replacement }),
      });
      setCredentialFor("");
      setReplacement({});
      await onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };

  const create = async () => {
    setBusy("create");
    setMessage("");
    try {
      await jsonRequest("/api/trading/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      setCreating(false);
      setForm({
        name: "",
        exchange: "paper",
        mode: "paper",
        initialBalance: "10000",
        maxConcurrentPositions: 20,
        credentials: {},
      });
      await onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <div className="operations-stack">
      <div className="operations-section-heading">
        <div>
          <h3>Börsenkonten</h3>
          <p>
            Die Positionsgrenze gilt kontoübergreifend für alle verbundenen
            Strategien.
          </p>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={() => setCreating((value) => !value)}
        >
          <Plus size={15} /> Konto
        </button>
      </div>
      {message && (
        <div className="builder-error">
          <AlertTriangle size={16} />
          {message}
        </div>
      )}
      {creating && (
        <section className="operations-card account-create">
          <label>
            Name
            <input
              value={form.name}
              onChange={(event) =>
                setForm({ ...form, name: event.target.value })
              }
            />
          </label>
          <label>
            Börse
            <select
              value={form.exchange}
              onChange={(event) => {
                const next = event.target.value;
                setForm({
                  ...form,
                  exchange: next,
                  mode: next === "paper" ? "paper" : "testnet",
                  credentials: {},
                });
              }}
            >
              {catalog?.exchanges.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Modus
            <select
              value={form.mode}
              onChange={(event) =>
                setForm({ ...form, mode: event.target.value })
              }
            >
              {exchange?.modes.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </label>
          <label>
            Max. Positionen
            <input
              type="number"
              min={1}
              max={20}
              value={form.maxConcurrentPositions}
              onChange={(event) =>
                setForm({
                  ...form,
                  maxConcurrentPositions: Number(event.target.value),
                })
              }
            />
          </label>
          {form.exchange === "paper" && (
            <label>
              Startkapital
              <input
                value={form.initialBalance}
                onChange={(event) =>
                  setForm({ ...form, initialBalance: event.target.value })
                }
              />
            </label>
          )}
          {exchange?.credentialFields.map((field) => (
            <label key={field.id}>
              {field.label}
              <input
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                value={form.credentials[field.id] || ""}
                onChange={(event) =>
                  setForm({
                    ...form,
                    credentials: {
                      ...form.credentials,
                      [field.id]: event.target.value,
                    },
                  })
                }
              />
            </label>
          ))}
          <div className="account-create-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy === "create"}
              onClick={() => {
                setCreating(false);
                setForm({
                  name: "",
                  exchange: "paper",
                  mode: "paper",
                  initialBalance: "10000",
                  maxConcurrentPositions: 20,
                  credentials: {},
                });
              }}
            >
              Abbrechen
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busy === "create" || !form.name.trim()}
              onClick={create}
            >
              {busy === "create" ? "Prüfe…" : "Konto anlegen & verifizieren"}
            </button>
          </div>
        </section>
      )}
      {trading?.accounts.map((account) => (
        <section className="operations-card account-card" key={account.id}>
          <div className="account-card-title">
            <div>
              <strong>{account.name}</strong>
              <span>
                {account.exchange} · {account.mode}
              </span>
            </div>
            <span
              className={`state-badge ${account.killSwitchActive ? "danger" : account.status === "ready" ? "healthy" : ""}`}
            >
              {account.killSwitchActive ? "gesperrt" : account.status}
            </span>
          </div>
          <div className="account-grid">
            <AccountPositionLimit
              account={account}
              disabled={busy === account.id}
              onSave={(maximum) =>
                updateAccount(account, { maxConcurrentPositions: maximum })
              }
            />
            <div>
              <span>Letzter Abgleich</span>
              <strong>{time(account.lastReconciledAt)}</strong>
            </div>
          </div>
          {account.killSwitchActive && (
            <div className="account-warning">
              <AlertTriangle size={15} />
              <span>{account.killSwitchReason || "Kontosperre aktiv"}</span>
              <button
                type="button"
                onClick={() => void releaseKillSwitch(account)}
              >
                Prüfen & freigeben
              </button>
            </div>
          )}
          {account.lastError && (
            <small className="error-text">{account.lastError}</small>
          )}
          {(trading?.accountIncidents || [])
            .filter((incident) => incident.accountId === account.id)
            .map((incident) => (
              <div className="account-incident" key={incident.id}>
                <div>
                  <strong>{incident.message}</strong>
                  <small>
                    {incident.category} · {incident.occurrenceCount} Beobachtungen · zuletzt {time(incident.lastSeenAt)}
                  </small>
                </div>
                <Badge
                  variant={incident.severity === "critical" ? "destructive" : "outline"}
                >
                  {incident.severity === "critical" ? "kritisch" : "Warnung"}
                </Badge>
              </div>
            ))}
          <div className="account-actions">
            <button
              type="button"
              disabled={busy === account.id}
              onClick={() => void accountAction(account, "reconcile")}
            >
              Abgleichen
            </button>
            {account.exchange !== "paper" && (
              <button
                type="button"
                disabled={busy === account.id}
                onClick={() => void accountAction(account, "verify")}
              >
                Verifizieren
              </button>
            )}
            <button
              type="button"
              disabled={busy === account.id}
              onClick={() => void accountAction(account, "toggle")}
            >
              {account.enabled ? "Deaktivieren" : "Aktivieren"}
            </button>
            {!account.killSwitchActive && (
              <button
                type="button"
                disabled={busy === account.id}
                onClick={() =>
                  void updateAccount(account, {
                    killSwitchActive: true,
                    killSwitchReason: "Manuell im Builder gesperrt",
                  })
                }
              >
                Sperren
              </button>
            )}
            {account.exchange !== "paper" && (
              <button
                type="button"
                disabled={busy === account.id}
                onClick={() => {
                  setCredentialFor(account.id);
                  setReplacement({});
                }}
              >
                Keys ersetzen
              </button>
            )}
            <button
              type="button"
              className="danger-text"
              disabled={busy === account.id}
              onClick={() => void accountAction(account, "delete")}
            >
              Löschen
            </button>
          </div>
          {credentialFor === account.id && (
            <div className="credential-replace">
              <p>
                Neue Keys werden write-only gespeichert und vor der Übernahme
                gegen dasselbe externe Konto geprüft.
              </p>
              {catalog?.exchanges
                .find((item) => item.id === account.exchange)
                ?.credentialFields.map((field) => (
                  <label key={field.id}>
                    {field.label}
                    <input
                      type={field.secret ? "password" : "text"}
                      autoComplete="off"
                      value={replacement[field.id] || ""}
                      onChange={(event) =>
                        setReplacement({
                          ...replacement,
                          [field.id]: event.target.value,
                        })
                      }
                    />
                  </label>
                ))}
              <div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setCredentialFor("")}
                >
                  Abbrechen
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy === account.id}
                  onClick={() => void replaceCredentials(account)}
                >
                  Prüfen & ersetzen
                </button>
              </div>
            </div>
          )}
        </section>
      ))}
      </div>
      <Dialog
        open={Boolean(releaseTarget)}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setReleaseTarget(null);
            setReleaseConfirmation("");
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <Badge variant="destructive">Kontoschutz</Badge>
            <DialogTitle>Kill-Switch sicher freigeben</DialogTitle>
            <DialogDescription>
              TSX Core führt vor der Freigabe zwei vollständige Börsenabgleiche
              durch. Unverwaltete Orders, Positionen oder fehlender Stop-Schutz
              verhindern die Freigabe.
            </DialogDescription>
          </DialogHeader>
          <label className="kill-switch-confirmation">
            Zur Bestätigung exakt „RELEASE ACCOUNT KILL SWITCH“ eingeben
            <Input
              autoComplete="off"
              value={releaseConfirmation}
              onChange={(event) => setReleaseConfirmation(event.target.value)}
            />
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={Boolean(busy)}
              onClick={() => setReleaseTarget(null)}
            >
              Abbrechen
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={
                Boolean(busy) ||
                releaseConfirmation !== "RELEASE ACCOUNT KILL SWITCH"
              }
              onClick={() => void confirmKillSwitchRelease()}
            >
              {busy ? "Prüfe Schutz…" : "Prüfen und freigeben"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Journal({
  trading,
  onRefresh,
}: {
  trading: TradingSnapshot | null;
  onRefresh: () => Promise<void>;
}) {
  const [entries, setEntries] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [filters, setFilters] = useState({ from: "", to: "", channelId: "", accountId: "", symbol: "", status: "" });
  const inFlight = useRef(false);
  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: "500" });
    if (filters.from) params.set("from", String(new Date(`${filters.from}T00:00:00`).getTime()));
    if (filters.to) params.set("to", String(new Date(`${filters.to}T23:59:59.999`).getTime()));
    if (filters.channelId) params.set("channelId", filters.channelId);
    if (filters.accountId) params.set("accountId", filters.accountId);
    if (filters.symbol) {
      const normalizedSymbol = filters.symbol.trim().toUpperCase().replace(/\//g, "");
      if (normalizedSymbol) params.set("symbol", normalizedSymbol);
    }
    if (filters.status) params.set("status", filters.status);
    return params.toString();
  }, [filters]);
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError("");
    try {
      const payload = await jsonRequest(`/api/trading/journal?${query}`);
      setEntries(payload.entries || []);
      setLastUpdated(Date.now());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, [query]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [load]);
  const exportJournal = async (format: "csv" | "json") => {
    setError("");
    try {
      const response = await apiFetch(`/api/trading/journal/export?${query}&format=${format}`);
      if (!response.ok) throw new Error(`Export fehlgeschlagen (${response.status}).`);
      const disposition = response.headers.get("Content-Disposition") || "";
      const headerName = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
      const fallbackName = `tsx-core-trade-journal-${new Date().toISOString().slice(0, 10)}.${format}`;
      const filename = headerName && /\.[a-z]+$/i.test(headerName) ? headerName : fallbackName;
      const mime = format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8";
      const typedBlob = new Blob([await response.blob()], { type: mime });
      const url = URL.createObjectURL(typedBlob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.type = mime;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const acknowledgeRisk = async (id: unknown) => {
    try {
      await jsonRequest("/api/trading/risk/acknowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const channels = [...new Set(entries.map((entry) => String(entry.channelId)))];
  return (
    <div className="operations-stack">
      <div className="operations-section-heading">
        <div>
          <h3>Trade Journal</h3>
          <p>Signal, Pfad, Konto und Ergebnis in einer Spur · {lastUpdated ? `aktualisiert ${time(lastUpdated)}` : "wird geladen"}.</p>
        </div>
        <div className="system-actions">
          <Button type="button" variant="outline" size="sm" onClick={() => void exportJournal("csv")}>CSV</Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void exportJournal("json")}>JSON</Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}><RefreshCw className={loading ? "spin" : ""} size={15} /> Aktualisieren</Button>
        </div>
      </div>
      <section className="operations-card journal-filterbar">
        <label><span>Von</span><Input type="date" value={filters.from} onChange={(event) => setFilters((value) => ({ ...value, from: event.target.value }))} /></label>
        <label><span>Bis</span><Input type="date" value={filters.to} onChange={(event) => setFilters((value) => ({ ...value, to: event.target.value }))} /></label>
        <label><span>Kanal</span><select value={filters.channelId} onChange={(event) => setFilters((value) => ({ ...value, channelId: event.target.value }))}><option value="">Alle Kanäle</option>{channels.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
        <label><span>Konto</span><select value={filters.accountId} onChange={(event) => setFilters((value) => ({ ...value, accountId: event.target.value }))}><option value="">Alle Konten</option>{(trading?.accounts || []).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
        <label><span>Symbol</span><Input value={filters.symbol} onChange={(event) => setFilters((value) => ({ ...value, symbol: event.target.value }))} placeholder="BTCUSDT" /></label>
        <label><span>Status</span><select value={filters.status} onChange={(event) => setFilters((value) => ({ ...value, status: event.target.value }))}><option value="">Alle Status</option><option value="completed">Abgeschlossen</option><option value="blocked">Blockiert</option><option value="failed">Fehlgeschlagen</option><option value="open">Offen</option></select></label>
      </section>
      {error && <div className="builder-error">{error}</div>}
      <div className="journal-list">
        {entries.map((entry) => (
          <article key={entry.intentId}>
            <div>
              <strong>
                {entry.symbol} · {entry.side}
              </strong>
              <span className="state-badge">{entry.status}</span>
            </div>
            <p>
              {entry.accountName} · {entry.exchange} · {entry.strategy?.name}
            </p>
            <small>
              {time(entry.createdAt)} · PnL{" "}
              {entry.position?.realizedPnl ?? "offen"}
            </small>
          </article>
        ))}
        {entries.length === 0 && <Empty text="Noch keine Journal-Einträge." />}
      </div>
      <section className="operations-card">
        <h3>Unquittierte Risikoereignisse</h3>
        {(trading?.activity.riskEvents || []).filter((event: any) => !event.acknowledgedAt).slice(0, 30).map((event: any) => (
          <div className="event-row journal-risk-row" key={event.id}>
            <span className={`severity ${event.severity}`}>{event.severity}</span>
            <div><strong>{event.code}</strong><small>{event.accountId || "global"} · {time(event.createdAt)}</small></div>
            <Button type="button" variant="outline" size="sm" onClick={() => void acknowledgeRisk(event.id)}>Quittieren</Button>
          </div>
        ))}
        {!(trading?.activity.riskEvents || []).some((event: any) => !event.acknowledgedAt) && <Empty text="Keine unquittierten Risikoereignisse." />}
      </section>
    </div>
  );
}

function metricNumber(value: unknown, digits = 2): string {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? new Intl.NumberFormat("de-DE", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(parsed)
    : "–";
}

function duration(value: unknown): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "–";
  return parsed < 1_000
    ? `${Math.round(parsed)} ms`
    : `${metricNumber(parsed / 1_000)} s`;
}

type AnalyticsRange = "24h" | "7d" | "30d" | "90d" | "all" | "custom";

function Analytics({ trading, filtersOpen }: { trading: TradingSnapshot | null; filtersOpen?: boolean }) {
  const [range, setRange] = useState<AnalyticsRange>("30d");
  const [customFrom, setCustomFrom] = useState("");
  const [customUntil, setCustomUntil] = useState("");
  const [channelId, setChannelId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [exchange, setExchange] = useState("");
  const [mode, setMode] = useState("");
  const [status, setStatus] = useState("");
  const [analytics, setAnalytics] = useState<any>(null);
  const [error, setError] = useState("");
  const [expectancy, setExpectancy] = useState({
    winRate: "50",
    averageWin: "2",
    averageLoss: "1",
  });
  const inFlight = useRef(false);
  const rerun = useRef(false);
  const currentQuery = useRef("");
  const query = useMemo(() => {
    const now = Date.now();
    const rangeMs: Record<Exclude<AnalyticsRange, "all" | "custom">, number> = {
      "24h": 86_400_000,
      "7d": 7 * 86_400_000,
      "30d": 30 * 86_400_000,
      "90d": 90 * 86_400_000,
    };
    const since = range === "all"
      ? 0
      : range === "custom"
        ? new Date(customFrom).getTime()
        : now - rangeMs[range];
    const until = range === "custom" ? new Date(customUntil).getTime() : now;
    const params = new URLSearchParams({
      since: String(Number.isFinite(since) ? since : 0),
      until: String(Number.isFinite(until) ? until : now),
    });
    if (channelId) params.set("channelId", channelId);
    if (accountId) params.set("accountId", accountId);
    if (exchange) params.set("exchange", exchange);
    if (mode) params.set("mode", mode);
    if (status) params.set("status", status);
    return params.toString();
  }, [accountId, channelId, customFrom, customUntil, exchange, mode, range, status]);
  const load = useCallback(async () => {
    if (range === "custom" && (!customFrom || !customUntil)) {
      return;
    }
    currentQuery.current = query;
    if (inFlight.current) {
      rerun.current = true;
      return;
    }
    inFlight.current = true;
    setError("");
    const requestedQuery = query;
    try {
      const payload = await jsonRequest(`/api/trading/analytics?${requestedQuery}`);
      if (currentQuery.current === requestedQuery) {
        setAnalytics(payload);
      }
    } catch (reason) {
      if (currentQuery.current === requestedQuery) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      inFlight.current = false;
      if (rerun.current) {
        rerun.current = false;
        void load();
      }
    }
  }, [customFrom, customUntil, query, range]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [load]);
  const channels = analytics?.performance?.channels || [];
  const exchanges = analytics?.performance?.exchanges || [];
  const equity = analytics?.performance?.equity || [];
  const adaptiveStates = trading?.workflowAdaptiveRisk?.states || [];
  const evaluations = trading?.workflowAdaptiveRisk?.evaluations || [];
  const execution = analytics?.execution || {};
  const totalPnl = channels.reduce(
    (total, item: any) => total + Number(item.realizedPnl || 0),
    0,
  );
  const closedTrades = channels.reduce(
    (total, item: any) => total + Number(item.closedTrades || 0),
    0,
  );
  const peakDrawdown = equity.reduce(
    (peak, point: any) => Math.max(peak, Number(point.drawdownPercent || 0)),
    0,
  );
  const funnel = Object.entries(execution.funnel || {}).map(([name, value]) => ({
    name: name.replaceAll("_", " "),
    value: Number(value),
  }));
  const expectancyValue =
    (Number(expectancy.winRate) / 100) * Number(expectancy.averageWin) -
    (1 - Number(expectancy.winRate) / 100) * Number(expectancy.averageLoss);
  const channelOptions = useMemo(
    () => [...new Set((trading?.channelAnalytics?.channels || []).map((item: any) => String(item.id)))],
    [trading?.channelAnalytics?.channels],
  );
  return (
    <div className="operations-stack">
      {filtersOpen && (
        <section className="operations-card analytics-filterbar" aria-label="Analysefilter">
        <label>
          <span>Zeitraum</span>
          <select value={range} onChange={(event) => setRange(event.target.value as AnalyticsRange)}>
            <option value="24h">24 Stunden</option>
            <option value="7d">7 Tage</option>
            <option value="30d">30 Tage</option>
            <option value="90d">90 Tage</option>
            <option value="all">Gesamt</option>
            <option value="custom">Benutzerdefiniert</option>
          </select>
        </label>
        {range === "custom" && (
          <>
            <label><span>Von</span><Input type="datetime-local" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} /></label>
            <label><span>Bis</span><Input type="datetime-local" value={customUntil} onChange={(event) => setCustomUntil(event.target.value)} /></label>
          </>
        )}
        <label><span>Kanal</span><select value={channelId} onChange={(event) => setChannelId(event.target.value)}><option value="">Alle Kanäle</option>{channelOptions.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
        <label><span>Konto</span><select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">Alle Konten</option>{(trading?.accounts || []).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
        <label><span>Börse</span><select value={exchange} onChange={(event) => setExchange(event.target.value)}><option value="">Alle Börsen</option><option value="paper">Paper</option><option value="hyperliquid">Hyperliquid</option><option value="bybit">Bybit</option><option value="krakenfutures">Kraken Futures</option></select></label>
        <label><span>Modus</span><select value={mode} onChange={(event) => setMode(event.target.value)}><option value="">Alle Modi</option><option value="paper">Paper</option><option value="testnet">Testnet</option><option value="live">Live</option></select></label>
        <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Alle Status</option><option value="completed">Abgeschlossen</option><option value="blocked">Blockiert</option><option value="failed">Fehlgeschlagen</option><option value="open">Offen</option></select></label>
      </section>
      )}
      {error && <div className="builder-error">{error}</div>}
      <div className="operations-metrics">
        <Metric label="Realisierter PnL" value={metricNumber(totalPnl)} />
        <Metric label="Geschlossene Trades" value={closedTrades} />
        <Metric
          label="Max. Drawdown %"
          value={metricNumber(peakDrawdown)}
          danger={peakDrawdown > 5}
        />
        <div className="operation-metric">
          <strong>
            {duration((execution as any).latencyMs?.signalToSubmit?.p95)}
          </strong>
          <span>Signal → Submit p95</span>
        </div>
      </div>
      <div className="analytics-chart-grid">
        <section className="operations-card analytics-chart">
          <h3>Equity-Verlauf</h3>
          {equity.length ? (
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={equity}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="observedAt" tickFormatter={(value) => new Date(value).toLocaleDateString("de-DE")} minTickGap={28} />
                <YAxis width={64} domain={["auto", "auto"]} />
                <Tooltip labelFormatter={(value) => time(value)} formatter={(value) => metricNumber(value)} />
                <Line type="monotone" dataKey="equity" stroke="var(--chart-1)" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          ) : <Empty text="Für diese Auswahl liegen keine Equity-Punkte vor." />}
        </section>
        <section className="operations-card analytics-chart">
          <h3>Drawdown</h3>
          {equity.length ? (
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart data={equity}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="observedAt" tickFormatter={(value) => new Date(value).toLocaleDateString("de-DE")} minTickGap={28} />
                <YAxis width={52} unit=" %" />
                <Tooltip labelFormatter={(value) => time(value)} formatter={(value) => `${metricNumber(value)} %`} />
                <Area type="monotone" dataKey="drawdownPercent" stroke="var(--destructive)" fill="color-mix(in oklch, var(--destructive) 22%, transparent)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : <Empty text="Für diese Auswahl liegt kein Drawdown vor." />}
        </section>
        <section className="operations-card analytics-chart">
          <h3>Realisierter PnL je Kanal</h3>
          {channels.length ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={channels}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="id" minTickGap={18} />
                <YAxis width={64} />
                <Tooltip formatter={(value) => metricNumber(value)} />
                <Bar dataKey="realizedPnl" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <Empty text="Keine abgeschlossenen Trades in dieser Auswahl." />}
        </section>
        <section className="operations-card analytics-chart">
          <h3>Ausführungs-Funnel</h3>
          {funnel.some((item) => item.value > 0) ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={funnel} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" allowDecimals={false} />
                <YAxis type="category" dataKey="name" width={110} />
                <Tooltip />
                <Bar dataKey="value" fill="var(--chart-3)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <Empty text="Keine Ausführungsereignisse in dieser Auswahl." />}
        </section>
      </div>
      <section className="operations-card">
        <h3>Kanalperformance</h3>
        <div
          className="analytics-table"
          role="table"
          aria-label="Kanalperformance"
        >
          <div className="analytics-row heading" role="row">
            <span>Kanal</span>
            <span>Trades</span>
            <span>W / L</span>
            <span>Win Rate</span>
            <span>PnL</span>
            <span>Slippage</span>
          </div>
          {channels.map((item: any) => (
            <div className="analytics-row" role="row" key={item.id}>
              <strong>{item.id}</strong>
              <span>{item.closedTrades}</span>
              <span>
                {item.wins} / {item.losses}
              </span>
              <span>{metricNumber(item.winRatePercent, 1)} %</span>
              <span>{metricNumber(item.realizedPnl)}</span>
              <span>
                {item.averageEntrySlippageBps == null
                  ? "–"
                  : `${metricNumber(item.averageEntrySlippageBps)} bps`}
              </span>
            </div>
          ))}
          {channels.length === 0 && (
            <Empty text="Noch keine abgeschlossenen Trades für eine Kanalbewertung." />
          )}
        </div>
      </section>
      <section className="operations-card">
        <h3>Börsenvergleich</h3>
        {exchanges.map((item: any) => (
          <div className="system-line" key={item.id}>
            <span>
              {item.id} · {item.completedIntents || 0}/{item.intents || 0}{" "}
              abgeschlossen
            </span>
            <strong>
              {item.averageEntrySlippageBps == null
                ? "keine Fills"
                : `${metricNumber(item.averageEntrySlippageBps)} bps`}
            </strong>
          </div>
        ))}
        {exchanges.length === 0 && (
          <Empty text="Noch keine Börsenausführungen." />
        )}
      </section>
      <section className="operations-card">
        <h3>Aktives adaptives Risiko je Pfad</h3>
        {adaptiveStates.map((item: any) => (
          <div className="adaptive-row" key={item.stateKey}>
            <div>
              <strong>
                {item.channelId} → {item.accountId}
              </strong>
              <small>
                {item.resourceName} · zuletzt {time(item.updatedAt)}
              </small>
            </div>
            <span
              className={`state-badge ${item.blocked ? "danger" : "healthy"}`}
            >
              {item.blocked
                ? "gesperrt"
                : `Stufe ${item.lockedTier ?? item.currentTier}`}
            </span>
          </div>
        ))}
        {adaptiveStates.length === 0 && (
          <Empty text="Noch kein adaptiver Pfad wurde ausgewertet." />
        )}
      </section>
      <section className="operations-card">
        <h3>Letzte adaptive Bewertungen</h3>
        {evaluations.filter((item: any) => (!channelId || item.channelId === channelId) && (!accountId || item.accountId === accountId)).slice(0, 30).map((item: any) => (
          <div className="adaptive-row" key={item.id}>
            <div>
              <strong>
                {item.channelId} · {item.action}
              </strong>
              <small>
                {item.reason} · {item.closedTrades} Trades · PnL{" "}
                {metricNumber(item.realizedPnl)}
              </small>
            </div>
            <span>
              Stufe {item.previousTier} → {item.appliedTier}
            </span>
          </div>
        ))}
        {evaluations.length === 0 && (
          <Empty text="Noch keine abgeschlossene adaptive Bewertung." />
        )}
      </section>
      <section className="operations-card">
        <h3>Erwartungswert-Rechner</h3>
        <div className="expectancy-grid">
          <label><span>Trefferquote %</span><Input type="number" min="0" max="100" value={expectancy.winRate} onChange={(event) => setExpectancy((value) => ({ ...value, winRate: event.target.value }))} /></label>
          <label><span>Ø Gewinn (R)</span><Input type="number" min="0" step="0.1" value={expectancy.averageWin} onChange={(event) => setExpectancy((value) => ({ ...value, averageWin: event.target.value }))} /></label>
          <label><span>Ø Verlust (R)</span><Input type="number" min="0" step="0.1" value={expectancy.averageLoss} onChange={(event) => setExpectancy((value) => ({ ...value, averageLoss: event.target.value }))} /></label>
          <div className={`expectancy-result ${expectancyValue < 0 ? "danger" : "healthy"}`}><strong>{metricNumber(expectancyValue, 3)} R</strong><span>Erwartungswert je Trade</span></div>
        </div>
      </section>
    </div>
  );
}

function Logs() {
  const [entries, setEntries] = useState<
    Array<{ cursor: number; line: string }>
  >([]);
  const cursor = useRef(0);
  const [paused, setPaused] = useState(false);
  const [search, setSearch] = useState("");
  const [regexMode, setRegexMode] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copyMessage, setCopyMessage] = useState("");
  const logView = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (paused) return;
    let alive = true;
    const poll = async () => {
      try {
        const payload = await jsonRequest(
          `/api/logs?after=${cursor.current}&limit=1000`,
        );
        if (!alive) return;
        const incoming = payload.entries || [];
        if (incoming.length)
          setEntries((previous) => [...previous, ...incoming].slice(-5000));
        cursor.current = payload.nextCursor ?? cursor.current;
      } catch {
        /* the next poll retries */
      }
    };
    void poll();
    const timer = window.setInterval(poll, 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [paused]);
  const match = useMemo(() => {
    if (!search) return () => true;
    if (!regexMode) {
      const needle = search.toLocaleLowerCase("de-DE");
      return (line: string) => line.toLocaleLowerCase("de-DE").includes(needle);
    }
    try {
      const pattern = new RegExp(search, "i");
      return (line: string) => pattern.test(line);
    } catch {
      return () => false;
    }
  }, [regexMode, search]);
  const matches = useMemo(() => entries.filter((entry) => match(entry.line)), [entries, match]);
  const visibleEntries = matches.slice(-1_000);
  useEffect(() => {
    if (!autoScroll || !logView.current) return;
    logView.current.scrollTop = logView.current.scrollHeight;
  }, [autoScroll, visibleEntries.length]);
  const copy = async (selected: typeof matches, label: string) => {
    try {
      await navigator.clipboard.writeText(selected.map((entry) => entry.line).join("\n"));
      setCopyMessage(`${label} kopiert (${selected.length}).`);
    } catch {
      setCopyMessage("Kopieren wurde vom Browser blockiert.");
    }
  };
  return (
    <div className="operations-stack">
      <div className="operations-section-heading">
        <div>
          <h3>Live Logs</h3>
          <p>
            Cursor {cursor.current} · {entries.length} Zeilen lokal
          </p>
        </div>
        <div className="system-actions">
          <Button type="button" variant="outline" size="sm" onClick={() => setPaused((value) => !value)}>{paused ? "Fortsetzen" : "Pausieren"}</Button>
          <Button type="button" variant="outline" size="sm" onClick={() => { setEntries([]); setCopyMessage("Lokale Ansicht geleert; die Serverhistorie bleibt erhalten."); }}>Ansicht leeren</Button>
        </div>
      </div>
      <section className="operations-card log-toolbar">
        <label><span>Textsuche</span><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Logs filtern" /></label>
        <label className="inline-check"><input type="checkbox" checked={regexMode} onChange={(event) => setRegexMode(event.target.checked)} /> Regex</label>
        <label className="inline-check"><input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} /> Autoscroll</label>
        <Button type="button" variant="outline" size="sm" onClick={() => void copy(visibleEntries, "Sichtbare Treffer")}>Sichtbare kopieren</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => void copy(matches, "Alle Treffer")}>Alle Treffer kopieren</Button>
      </section>
      {copyMessage && <div className="builder-message">{copyMessage}</div>}
      <div className="compact-log" role="log" ref={logView}>
        {visibleEntries.map((entry) => (
          <div key={entry.cursor}>
            <span>{entry.cursor}</span>
            {entry.line}
          </div>
        ))}
        {matches.length === 0 && <Empty text={entries.length ? "Keine passenden Log-Einträge." : "Warte auf Log-Einträge …"} />}
      </div>
    </div>
  );
}

function Backups() {
  const [backups, setBackups] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [offsiteObject, setOffsiteObject] = useState("");
  const load = useCallback(
    () =>
      jsonRequest("/api/backups")
        .then((payload) => setBackups(payload.backups || []))
        .catch((reason) => setMessage(reason.message)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const create = async () => {
    setBusy(true);
    try {
      const result = await jsonRequest("/api/operations/backup", {
        method: "POST",
      });
      setMessage(`Verifiziertes Backup erstellt: ${result.artifact}`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const verify = async (name: string) => {
    setBusy(true);
    try {
      await jsonRequest(`/api/backups/verify?name=${encodeURIComponent(name)}`);
      setMessage(`${name} ist vollständig und lesbar.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const restore = async (name: string) => {
    if (
      window.prompt(
        `${name} vollständig wiederherstellen und den Dienst neu starten. RESTORE eingeben:`,
      ) !== "RESTORE"
    )
      return;
    setBusy(true);
    try {
      await jsonRequest("/api/backups/restore", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Destructive-Confirmation": "restore-backup",
        },
        body: JSON.stringify({ name }),
      });
      clearDashboardToken();
      setMessage("Backup wiederhergestellt. Dienst startet neu …");
      window.setTimeout(() => {
        window.location.href = "/";
      }, 2_500);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };
  const recover = async () => {
    const objectName = offsiteObject.trim();
    if (
      !objectName ||
      window.prompt(
        `${objectName} herunterladen, entschlüsseln und verifizieren. RECOVER eingeben:`,
      ) !== "RECOVER"
    )
      return;
    setBusy(true);
    try {
      const payload = await jsonRequest("/api/backups/recover-offsite", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Destructive-Confirmation": "recover-offsite-backup",
        },
        body: JSON.stringify({ objectName }),
      });
      setMessage(`Off-site-Backup lokal verifiziert: ${payload.artifactName}`);
      setOffsiteObject("");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="operations-stack">
      <div className="operations-section-heading">
        <div>
          <h3>Verifizierte Backups</h3>
          <p>Datenbank, Workflow-Revisionen und Konfiguration.</p>
        </div>
        <button
          type="button"
          className="primary-button"
          disabled={busy}
          onClick={create}
        >
          <DatabaseBackup size={15} /> Jetzt sichern
        </button>
      </div>
      {message && <div className="builder-info">{message}</div>}
      {backups.map((name) => (
        <div className="backup-row" key={name}>
          <span>{name}</span>
          <div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void verify(name)}
            >
              Prüfen
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void restore(name)}
            >
              Wiederherstellen
            </button>
          </div>
        </div>
      ))}
      {backups.length === 0 && <Empty text="Keine Backups gefunden." />}
      <section className="operations-card system-form">
        <h3>Off-site-Backup zurückholen</h3>
        <label>
          Objektname
          <input
            value={offsiteObject}
            onChange={(event) => setOffsiteObject(event.target.value)}
            placeholder="backup-….tgfb"
          />
        </label>
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !offsiteObject.trim()}
          onClick={() => void recover()}
        >
          Herunterladen & prüfen
        </button>
      </section>
    </div>
  );
}

function Mcp() {
  const [snapshot, setSnapshot] = useState<any>(null);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState("");
  const [issuedToken, setIssuedToken] = useState("");
  const [form, setForm] = useState({
    name: "",
    permissions: [] as string[],
    eventSubscriptions: [] as string[],
    enabled: true,
  });
  const load = useCallback(async () => {
    try {
      setSnapshot(await jsonRequest("/api/mcp"));
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [load]);
  const selected =
    snapshot?.agents?.find((agent: any) => agent.id === selectedId) || null;
  useEffect(() => {
    if (!selected) return;
    setForm({
      name: selected.name,
      permissions: [...selected.permissions],
      eventSubscriptions: [...selected.eventSubscriptions],
      enabled: selected.enabled,
    });
  }, [selected]);
  const call = async (
    key: string,
    url: string,
    body: unknown,
    confirmation?: string,
    method = "POST",
  ) => {
    setBusy(key);
    setError("");
    try {
      const result = await jsonRequest(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(confirmation
            ? { "X-Destructive-Confirmation": confirmation }
            : {}),
        },
        body: JSON.stringify(body),
      });
      await load();
      return result;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return null;
    } finally {
      setBusy("");
    }
  };
  const runtime = async (mode: string) => {
    if (mode === snapshot?.runtime?.mode) return;
    if (!window.confirm(`MCP-Laufzeit wirklich auf „${mode}“ setzen?`)) return;
    await call(
      `runtime-${mode}`,
      "/api/mcp/runtime",
      { mode },
      mode === "active"
        ? "set-mcp-runtime-active"
        : mode === "disabled"
          ? "set-mcp-runtime-disabled"
          : undefined,
    );
  };
  const startNew = () => {
    setCreating(true);
    setSelectedId("");
    setIssuedToken("");
    setForm({
      name: "",
      permissions: (snapshot?.permissions || []).filter((item: string) =>
        item.endsWith(".read"),
      ),
      eventSubscriptions: [
        "signal_received",
        "exchange_ack",
        "first_fill",
        "position_closed",
        "kill_switch_activated",
      ],
      enabled: true,
    });
  };
  const save = async () => {
    const result = selected
      ? await call("save-agent", "/api/mcp/agents/update", {
          id: selected.id,
          ...form,
        })
      : await call("create-agent", "/api/mcp/agents", form);
    if (!selected && result?.token) {
      setIssuedToken(result.token);
      setSelectedId(result.agent.id);
      setCreating(false);
    }
  };
  const toggleList = (
    key: "permissions" | "eventSubscriptions",
    value: string,
  ) => {
    setForm((previous) => ({
      ...previous,
      [key]: previous[key].includes(value)
        ? previous[key].filter((item) => item !== value)
        : [...previous[key], value],
    }));
  };
  const rotate = async () => {
    if (
      !selected ||
      !window.confirm(
        `Token von „${selected.name}“ rotieren und alle Sitzungen trennen?`,
      )
    )
      return;
    const result = await call(
      "rotate-agent",
      "/api/mcp/agents/rotate",
      { id: selected.id },
      "rotate-mcp-agent-token",
    );
    if (result?.token) setIssuedToken(result.token);
  };
  const remove = async () => {
    if (
      !selected ||
      window.prompt(
        `Agent „${selected.name}“ endgültig widerrufen. DELETE eingeben:`,
      ) !== "DELETE"
    )
      return;
    const result = await call(
      "delete-agent",
      "/api/mcp/agents",
      { id: selected.id },
      "delete-mcp-agent",
      "DELETE",
    );
    if (result) {
      setSelectedId("");
      setCreating(false);
      setIssuedToken("");
    }
  };
  const decide = async (proposal: any, approve: boolean) => {
    const reason = approve ? undefined : window.prompt("Ablehnungsgrund:");
    if (!approve && !reason) return;
    await call(
      `${approve ? "approve" : "reject"}-${proposal.id}`,
      `/api/mcp/proposals/${approve ? "approve" : "reject"}`,
      approve ? { id: proposal.id } : { id: proposal.id, reason },
      approve ? "approve-mcp-proposal" : undefined,
    );
  };
  const showEditor = creating || selected;
  return (
    <div className="operations-stack">
      <div className="operations-section-heading">
        <div>
          <h3>MCP & Agenten</h3>
          <p>Dieselben Workflow-, Risiko- und Audit-Grenzen wie im Builder.</p>
        </div>
        <button type="button" className="secondary-button" onClick={startNew}>
          <Plus size={14} /> Agent
        </button>
      </div>
      {error && <div className="builder-error">{error}</div>}
      <section className="operations-card">
        <h3>Laufzeitmodus</h3>
        <div className="mcp-mode-grid">
          {["active", "standby", "disabled"].map((mode) => (
            <button
              type="button"
              key={mode}
              disabled={Boolean(busy)}
              className={snapshot?.runtime?.mode === mode ? "active" : ""}
              onClick={() => void runtime(mode)}
            >
              {mode}
            </button>
          ))}
        </div>
        <div className="system-line">
          <span>Endpoint</span>
          <strong>{snapshot?.endpoint || "nicht veröffentlicht"}</strong>
        </div>
      </section>
      {issuedToken && (
        <section className="operations-card one-time-token">
          <h3>Einmal-Token – jetzt sicher speichern</h3>
          <code>{issuedToken}</code>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void navigator.clipboard.writeText(issuedToken)}
          >
            Kopieren
          </button>
        </section>
      )}
      <section className="operations-card">
        <h3>Agenten</h3>
        <div className="agent-grid">
          {snapshot?.agents?.map((agent: any) => (
            <button
              type="button"
              key={agent.id}
              className={selectedId === agent.id ? "selected" : ""}
              onClick={() => {
                setCreating(false);
                setSelectedId(agent.id);
                setIssuedToken("");
              }}
            >
              <span
                className={`status-dot ${agent.enabled ? "healthy" : "muted"}`}
              />
              <strong>{agent.name}</strong>
              <small>
                {agent.tokenPrefix}… · {agent.permissions.length} Rechte
              </small>
            </button>
          ))}
          {!snapshot?.agents?.length && (
            <Empty text="Noch keine MCP-Agenten." />
          )}
        </div>
      </section>
      {showEditor && (
        <section className="operations-card mcp-editor">
          <h3>{selected ? "Agent bearbeiten" : "Agent erstellen"}</h3>
          <label>
            Name
            <input
              value={form.name}
              onChange={(event) =>
                setForm({ ...form, name: event.target.value })
              }
            />
          </label>
          <label className="builder-toggle">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) =>
                setForm({ ...form, enabled: event.target.checked })
              }
            />
            <span aria-hidden="true" /> Agent aktiviert
          </label>
          <fieldset>
            <legend>Berechtigungen</legend>
            <div className="permission-grid">
              {snapshot?.permissions?.map((permission: string) => (
                <label key={permission}>
                  <input
                    type="checkbox"
                    checked={form.permissions.includes(permission)}
                    onChange={() => toggleList("permissions", permission)}
                  />
                  {permission}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>Ereignisse</legend>
            <div className="permission-grid">
              {snapshot?.eventTypes?.map((eventType: string) => (
                <label key={eventType}>
                  <input
                    type="checkbox"
                    checked={form.eventSubscriptions.includes(eventType)}
                    onChange={() => toggleList("eventSubscriptions", eventType)}
                  />
                  {eventType}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="mcp-editor-actions">
            {selected && (
              <button
                type="button"
                className="danger-button"
                disabled={Boolean(busy)}
                onClick={() => void remove()}
              >
                Löschen
              </button>
            )}
            {selected && (
              <button
                type="button"
                className="secondary-button"
                disabled={Boolean(busy)}
                onClick={() => void rotate()}
              >
                Token rotieren
              </button>
            )}
            <button
              type="button"
              className="primary-button"
              disabled={Boolean(busy) || !form.name.trim()}
              onClick={() => void save()}
            >
              Speichern
            </button>
          </div>
        </section>
      )}
      <section className="operations-card">
        <h3>Freigabe-Warteschlange</h3>
        {snapshot?.proposals
          ?.filter((item: any) => item.status === "pending")
          .map((proposal: any) => (
            <div className="proposal-row" key={proposal.id}>
              <div>
                <strong>{proposal.action}</strong>
                <small>
                  {proposal.agentName} · bis {time(proposal.expiresAt)}
                </small>
                {proposal.preflight?.blockers?.map((item: string) => (
                  <small className="error-text" key={item}>
                    {item}
                  </small>
                ))}
              </div>
              <div>
                <button
                  type="button"
                  disabled={
                    Boolean(busy) || proposal.preflight?.allowed !== true
                  }
                  onClick={() => void decide(proposal, true)}
                >
                  Genehmigen
                </button>
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void decide(proposal, false)}
                >
                  Ablehnen
                </button>
              </div>
            </div>
          ))}
        {!snapshot?.proposals?.some(
          (item: any) => item.status === "pending",
        ) && <Empty text="Keine offenen Vorschläge." />}
      </section>
      <section className="operations-card">
        <h3>Aktive Sitzungen & letzte Aktionen</h3>
        <div className="system-line">
          <span>Aktive Sitzungen</span>
          <strong>
            {snapshot?.sessions?.filter(
              (item: any) => item.disconnectedAt == null,
            ).length || 0}
          </strong>
        </div>
        {snapshot?.actions?.slice(0, 12).map((action: any) => (
          <div className="mcp-action" key={action.id}>
            <span
              className={`state-badge ${action.outcome === "succeeded" ? "healthy" : action.outcome === "failed" ? "danger" : ""}`}
            >
              {action.outcome}
            </span>
            <div>
              <strong>{action.toolName}</strong>
              <small>
                {action.agentName} · {action.durationMs} ms ·{" "}
                {time(action.completedAt)}
              </small>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function System({
  catalog,
  systemStatus,
  onRefresh,
}: {
  catalog: ExchangeCatalog | null;
  systemStatus: Record<string, any> | null;
  onRefresh: () => Promise<void>;
}) {
  const [config, setConfig] = useState<any>(null);
  const [runtime, setRuntime] = useState<any>(null);
  const [secrets, setSecrets] = useState<any>(null);
  const [recovery, setRecovery] = useState<any>(null);
  const [operations, setOperations] = useState<any>(null);
  const [access, setAccess] = useState<any>(null);
  const [setupPreview, setSetupPreview] = useState<any>(null);
  const [setupMappings, setSetupMappings] = useState<Record<string, string>>({});
  const [setupConfirmation, setSetupConfirmation] = useState("");
  const [dangerConfirmation, setDangerConfirmation] = useState("");
  const [secretInput, setSecretInput] = useState<Record<string, string>>({});
  const [loginValue, setLoginValue] = useState("");
  const [loginName, setLoginName] = useState({ firstName: "", lastName: "" });
  const [issuedToken, setIssuedToken] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const [configuration, runtimePayload, secretPayload, recoveryPayload, operationsPayload, accessPayload] =
      await Promise.all([
        jsonRequest("/api/config"),
        jsonRequest("/api/runtime-settings"),
        jsonRequest("/api/secrets"),
        jsonRequest("/api/recovery"),
        jsonRequest("/api/operations"),
        jsonRequest("/api/access"),
      ]);
    setConfig(configuration);
    setRuntime(runtimePayload.settings);
    setSecrets(secretPayload.secrets);
    setRecovery(recoveryPayload);
    setOperations(operationsPayload.operations || {});
    setAccess(accessPayload);
  }, []);
  useEffect(() => {
    void load().catch((reason) => setMessage(reason.message));
  }, [load]);
  const execute = async (
    key: string,
    operation: () => Promise<any>,
    success: string,
  ) => {
    setBusy(key);
    setMessage("");
    try {
      const result = await operation();
      setMessage(success);
      await Promise.all([load(), onRefresh()]);
      return result;
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
      return null;
    } finally {
      setBusy("");
    }
  };
  const saveCore = async () => {
    const secretUpdates = Object.fromEntries(
      Object.entries(secretInput).filter(([, value]) => value.trim()),
    );
    await execute(
      "core",
      async () => {
        await jsonRequest("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            apiId: Number(config.apiId || 0),
            targetChannel: String(config.targetChannel || ""),
            xmlParsing: {
              ...config.xmlParsing,
              saveToFile: false,
              signalsDir: "./signals",
              aiLimits: {
                ...config.xmlParsing.aiLimits,
                requestTimeoutMs: Math.min(
                  120_000,
                  Number(
                    config.xmlParsing.aiLimits?.requestTimeoutMs || 120_000,
                  ),
                ),
              },
            },
          }),
        });
        if (Object.keys(secretUpdates).length)
          await jsonRequest("/api/secrets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(secretUpdates),
          });
        setSecretInput({});
      },
      "Telegram- und KI-Grundkonfiguration gespeichert.",
    );
  };
  const saveRuntime = async () => {
    await execute(
      "runtime",
      async () => {
        const payload = await jsonRequest("/api/runtime-settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(runtime),
        });
        setRuntime(payload.settings);
      },
      "Runtime-Einstellungen gespeichert. Ein kontrollierter Neustart ist erforderlich.",
    );
  };
  const routing = async (action: "start" | "stop") => {
    await execute(
      `routing-${action}`,
      () =>
        jsonRequest("/api/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        }),
      action === "start"
        ? "Telegram-Verbindung wird aufgebaut."
        : "Telegram-Routing wurde gestoppt.",
    );
  };
  const submitLogin = async () => {
    const prompt = systemStatus?.telegramLogin?.prompt;
    const body = prompt?.kind === "name" ? loginName : { value: loginValue };
    await execute(
      "telegram-login",
      () =>
        jsonRequest("/api/telegram-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      "Telegram-Anmeldedaten übermittelt.",
    );
    setLoginValue("");
    setLoginName({ firstName: "", lastName: "" });
  };
  const rotateToken = async (role: "admin" | "viewer") => {
    if (
      !window.confirm(
        `${role === "admin" ? "Admin" : "Viewer"}-Key wirklich rotieren?`,
      )
    )
      return;
    const result = await execute(
      `token-${role}`,
      () =>
        jsonRequest("/api/access-tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role }),
        }),
      `${role}-Key rotiert. Der neue Wert wird nur jetzt angezeigt.`,
    );
    if (result?.token) {
      setIssuedToken(result.token);
      if (role === "admin") setDashboardToken(result.token);
    }
  };
  const restart = async () => {
    if (
      !window.confirm(
        "Dienst kontrolliert neu starten und die gespeicherten Runtime-Einstellungen aktivieren?",
      )
    )
      return;
    const result = await execute(
      "restart",
      () =>
        jsonRequest("/api/restart", {
          method: "POST",
          headers: { "X-Destructive-Confirmation": "restart-service" },
        }),
      "Neustart wurde angefordert.",
    );
    if (result) {
      clearDashboardToken();
      window.setTimeout(() => {
        window.location.href = "/";
      }, 2_500);
    }
  };
  const revokeViewer = async () => {
    if (!window.confirm("Viewer-Key widerrufen und bestehende Viewer-Anmeldungen ungültig machen?")) return;
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
    const result = await execute(
      `danger-${kind}`,
      () => jsonRequest(kind === "clear" ? "/api/clear-database" : "/api/factory-reset", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Destructive-Confirmation": kind === "clear" ? "clear-database" : "factory-reset",
        },
        body: JSON.stringify({ confirmation: expected }),
      }),
      kind === "clear" ? "Betriebsdatenbank wurde geleert." : "Factory Reset wurde gestartet.",
    );
    if (result && kind === "factory") {
      clearDashboardToken();
      window.setTimeout(() => { window.location.href = "/"; }, 2_500);
    }
    if (result) setDangerConfirmation("");
  };
  if (!config || !runtime)
    return (
      <div className="operations-stack">
        <Empty text={message || "Systemkonfiguration wird geladen …"} />
      </div>
    );
  const login = systemStatus?.telegramLogin || { state: "idle" };
  const runtimeKeys = Object.keys(runtime).filter(
    (key) =>
      ![
        "enterpriseMode",
        "dashboardAuthMode",
        "dashboardLocalTrust",
        "dashboardAllowedOrigin",
        "tailscaleServeTrustedProxy",
        "tailscaleAdminUsers",
        "tailscaleViewerUsers",
      ].includes(key),
  );
  return (
    <div className="operations-stack">
      {message && <div className="builder-info">{message}</div>}
      {recovery?.active && (
        <div className="builder-error">
          <AlertTriangle size={15} />
          Recovery-Modus:{" "}
          {(recovery.issues || []).map((item: any) => item.reason).join(" · ")}
        </div>
      )}
      <section className="operations-card">
        <h3>Telegram-Routing</h3>
        <div className="system-line">
          <span>Verbindung</span>
          <strong>{systemStatus?.connectionState || "unbekannt"}</strong>
        </div>
        <div className="system-line">
          <span>Aktive Builder-Quellen</span>
          <strong>{systemStatus?.resolvedSources?.length ?? 0}</strong>
        </div>
        <div className="system-line">
          <span>Queue</span>
          <strong>
            {systemStatus?.queue?.running ?? 0} aktiv ·{" "}
            {systemStatus?.queue?.queued ?? 0} wartend
          </strong>
        </div>
        <div className="system-actions">
          <button
            type="button"
            className="primary-button"
            disabled={Boolean(busy) || systemStatus?.isRunning}
            onClick={() => void routing("start")}
          >
            Starten
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={Boolean(busy) || !systemStatus?.isRunning}
            onClick={() => void routing("stop")}
          >
            Stoppen
          </button>
        </div>
      </section>
      {login.state === "waiting" && (
        <section className="operations-card system-form">
          <h3>Telegram-Anmeldung · {login.prompt?.label}</h3>
          {login.prompt?.kind === "otherDeviceConfirmation" ? (
            <a
              className="secondary-button"
              href={login.prompt.link}
              target="_blank"
              rel="noreferrer"
            >
              In Telegram bestätigen
            </a>
          ) : login.prompt?.kind === "name" ? (
            <>
              <label>
                Vorname
                <input
                  value={loginName.firstName}
                  onChange={(event) =>
                    setLoginName({
                      ...loginName,
                      firstName: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                Nachname
                <input
                  value={loginName.lastName}
                  onChange={(event) =>
                    setLoginName({ ...loginName, lastName: event.target.value })
                  }
                />
              </label>
            </>
          ) : (
            <label>
              {login.prompt?.label}
              <input
                type={login.prompt?.kind === "password" ? "password" : "text"}
                autoComplete="off"
                value={loginValue}
                onChange={(event) => setLoginValue(event.target.value)}
              />
            </label>
          )}{" "}
          {login.prompt?.kind !== "otherDeviceConfirmation" && (
            <button
              type="button"
              className="primary-button"
              disabled={Boolean(busy)}
              onClick={() => void submitLogin()}
            >
              Weiter
            </button>
          )}
        </section>
      )}
      <section className="operations-card system-form">
        <h3>Telegram & KI-Grundlage</h3>
        <div className="builder-field-grid">
          <label>
            Telegram API ID
            <input
              type="number"
              value={config.apiId || ""}
              onChange={(event) =>
                setConfig({ ...config, apiId: Number(event.target.value) })
              }
            />
          </label>
          <label>
            Telegram API Hash ·{" "}
            {secrets?.telegramApiHash?.configured ? "gespeichert" : "fehlt"}
            <input
              type="password"
              autoComplete="off"
              placeholder="Leer lassen zum Beibehalten"
              value={secretInput.telegramApiHash || ""}
              onChange={(event) =>
                setSecretInput({
                  ...secretInput,
                  telegramApiHash: event.target.value,
                })
              }
            />
          </label>
          <label>
            OpenRouter API Key ·{" "}
            {secrets?.openRouterApiKey?.configured ? "gespeichert" : "fehlt"}
            <input
              type="password"
              autoComplete="off"
              placeholder="Leer lassen zum Beibehalten"
              value={secretInput.openRouterApiKey || ""}
              onChange={(event) =>
                setSecretInput({
                  ...secretInput,
                  openRouterApiKey: event.target.value,
                })
              }
            />
          </label>
          <label>
            Telegram-Ziel (nur bei Ausgabe-Baustein)
            <input
              value={config.targetChannel || ""}
              onChange={(event) =>
                setConfig({ ...config, targetChannel: event.target.value })
              }
            />
          </label>
          <label>
            Primärmodell
            <input
              value={config.xmlParsing.primaryModel || ""}
              onChange={(event) =>
                setConfig({
                  ...config,
                  xmlParsing: {
                    ...config.xmlParsing,
                    primaryModel: event.target.value,
                  },
                })
              }
            />
          </label>
          <label>
            Fallback-Modell
            <input
              value={config.xmlParsing.fallbackModel || ""}
              onChange={(event) =>
                setConfig({
                  ...config,
                  xmlParsing: {
                    ...config.xmlParsing,
                    fallbackModel: event.target.value,
                  },
                })
              }
            />
          </label>
        </div>
        <label className="builder-toggle">
          <input
            type="checkbox"
            checked={config.xmlParsing.externalDataPolicyAccepted === true}
            onChange={(event) =>
              setConfig({
                ...config,
                xmlParsing: {
                  ...config.xmlParsing,
                  externalDataPolicyAccepted: event.target.checked,
                },
              })
            }
          />
          <span aria-hidden="true" /> Externe KI-Datenverarbeitung rechtlich
          freigegeben
        </label>
        <div className="builder-locked-note">
          <Check size={15} /> Parser-Signale werden nie in Dateien gespeichert.
        </div>
        <button
          type="button"
          className="primary-button"
          disabled={Boolean(busy)}
          onClick={() => void saveCore()}
        >
          Grundkonfiguration speichern
        </button>
      </section>
      <section className="operations-card system-form">
        <h3>Dashboard-Zugriff</h3>
        <div className="builder-field-grid">
          <label>
            Authentifizierung
            <select
              value={runtime.dashboardAuthMode}
              onChange={(event) =>
                setRuntime({
                  ...runtime,
                  dashboardAuthMode: event.target.value,
                  ...(event.target.value === "tailscale"
                    ? {
                        dashboardLocalTrust: false,
                        tailscaleServeTrustedProxy: true,
                      }
                    : {}),
                })
              }
            >
              <option value="token">Bearer / lokal</option>
              <option value="tailscale">Tailscale Serve Identity</option>
              <option value="oidc">OIDC</option>
            </select>
          </label>
          <label>
            Erlaubte Origin
            <input
              value={runtime.dashboardAllowedOrigin}
              onChange={(event) =>
                setRuntime({
                  ...runtime,
                  dashboardAllowedOrigin: event.target.value,
                })
              }
            />
          </label>
          <label>
            Tailscale Admin-Logins
            <input
              value={runtime.tailscaleAdminUsers}
              onChange={(event) =>
                setRuntime({
                  ...runtime,
                  tailscaleAdminUsers: event.target.value,
                })
              }
            />
          </label>
          <label>
            Tailscale Viewer-Logins
            <input
              value={runtime.tailscaleViewerUsers}
              onChange={(event) =>
                setRuntime({
                  ...runtime,
                  tailscaleViewerUsers: event.target.value,
                })
              }
            />
          </label>
        </div>
        <div className="builder-field-grid">
          <label className="builder-toggle">
            <input
              type="checkbox"
              checked={runtime.dashboardLocalTrust}
              onChange={(event) =>
                setRuntime({
                  ...runtime,
                  dashboardLocalTrust: event.target.checked,
                })
              }
            />
            <span aria-hidden="true" /> Lokale Vertrauenssitzung
          </label>
          <label className="builder-toggle">
            <input
              type="checkbox"
              checked={runtime.tailscaleServeTrustedProxy}
              onChange={(event) =>
                setRuntime({
                  ...runtime,
                  tailscaleServeTrustedProxy: event.target.checked,
                })
              }
            />
            <span aria-hidden="true" /> Tailscale-Serve-Proxy vertrauen
          </label>
          <label className="builder-toggle">
            <input
              type="checkbox"
              checked={runtime.enterpriseMode}
              onChange={(event) =>
                setRuntime({
                  ...runtime,
                  enterpriseMode: event.target.checked,
                  ...(event.target.checked
                    ? {
                        dashboardAuthMode: "oidc",
                        dashboardLocalTrust: false,
                        auditRemoteRequired: true,
                        backupOffsiteRequired: true,
                      }
                    : {}),
                })
              }
            />
            <span aria-hidden="true" /> Enterprise-Modus
          </label>
        </div>
        <details>
          <summary>Vollständige Runtime- und Enterprise-Parameter</summary>
          <div className="runtime-grid">
            {runtimeKeys.map((key) => (
              <label key={key}>
                {key}
                {typeof runtime[key] === "boolean" ? (
                  <input
                    type="checkbox"
                    checked={runtime[key]}
                    onChange={(event) =>
                      setRuntime({ ...runtime, [key]: event.target.checked })
                    }
                  />
                ) : (
                  <input
                    type={typeof runtime[key] === "number" ? "number" : "text"}
                    value={runtime[key]}
                    onChange={(event) =>
                      setRuntime({
                        ...runtime,
                        [key]:
                          typeof runtime[key] === "number"
                            ? Number(event.target.value)
                            : event.target.value,
                      })
                    }
                  />
                )}
              </label>
            ))}
          </div>
        </details>
        <button
          type="button"
          className="primary-button"
          disabled={Boolean(busy)}
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
      </section>
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
          onClick={() => void saveCore()}
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
        {issuedToken && (
          <div className="one-time-inline">
            <strong>Nur jetzt sichtbar</strong>
            <code>{issuedToken}</code>
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(issuedToken)}
            >
              Kopieren
            </button>
          </div>
        )}
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
            <Button type="button" variant="destructive" disabled={Boolean(busy) || setupConfirmation !== setupPreview.confirmation || (setupPreview.accountReferences || []).some((reference: any) => !setupMappings[reference.sourceAccountId])} onClick={() => void applySetup()}>
              {busy === "setup-apply" ? "Sichere und ersetze…" : "Bestehendes Setup sicher ersetzen"}
            </Button>
          </div>
        )}
      </section>
      <section className="operations-card">
        <h3>Audit und Diagnose</h3>
        <div className="system-line"><span>Audit-Zustand</span><strong>{operations?.audit?.healthy === false ? "gestört" : "bereit"}</strong></div>
        <div className="system-line"><span>Letzte erfolgreiche Sicherung</span><strong>{time(operations?.backup?.lastSuccessAt)}</strong></div>
        <div className="system-actions">
          <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => void replayAudit()}>Audit erneut übertragen</Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => window.open("/api/status", "_blank", "noopener,noreferrer")}
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
            <span>{exchange.name}</span>
            <strong>{exchange.modes.join(" · ")}</strong>
          </div>
        ))}
      </section>
      <section className="operations-card danger-zone">
        <h3>Gefahrenzone</h3>
        <p>Nur mit Administratorrolle und einer aktuellen, gesunden Sicherung. „Datenbank leeren“ bewahrt Trading-Zustand gemäß Serverrichtlinie; Factory Reset entfernt die vollständige lokale Installation.</p>
        <div className="system-line"><span>Sicherung</span><strong>{operations?.backup?.healthy ? `gesund · ${time(operations.backup.lastSuccessAt)}` : "nicht aktuell – Aktion gesperrt"}</strong></div>
        <label><span>Bestätigung</span><Input autoComplete="off" value={dangerConfirmation} onChange={(event) => setDangerConfirmation(event.target.value)} placeholder="DATENBANK LEEREN oder FACTORY RESET" /></label>
        <div className="system-actions">
          <Button type="button" variant="destructive" disabled={Boolean(busy) || !operations?.backup?.healthy || dangerConfirmation !== "DATENBANK LEEREN"} onClick={() => void dangerAction("clear")}>Datenbank leeren</Button>
          <Button type="button" variant="destructive" disabled={Boolean(busy) || !operations?.backup?.healthy || dangerConfirmation !== "FACTORY RESET"} onClick={() => void dangerAction("factory")}>Factory Reset</Button>
        </div>
      </section>
    </div>
  );
}

type OperationsWorkspaceProps = {
  trading: TradingSnapshot | null;
  catalog: ExchangeCatalog | null;
  systemStatus: Record<string, any> | null;
  onRefresh: () => Promise<void>;
  initialTab?: OperationTab;
  availableTabs?: OperationTab[];
  ariaLabel?: string;
  title?: string;
  description?: string;
  filtersOpen?: boolean;
};

export function OperationsWorkspace({
  trading,
  catalog,
  systemStatus,
  onRefresh,
  initialTab = "overview",
  availableTabs = TABS.map((item) => item.id),
  ariaLabel = "Betrieb",
  title,
  description,
  filtersOpen,
}: Readonly<OperationsWorkspaceProps>) {
  const [tab, setTab] = useState<OperationTab>(initialTab);
  useEffect(() => {
    if (!availableTabs.includes(tab)) setTab(initialTab);
  }, [availableTabs, initialTab, tab]);
  const content = useMemo(() => {
    if (tab === "overview")
      return (
        <Overview
          trading={trading}
          systemStatus={systemStatus}
          onRefresh={onRefresh}
        />
      );
    if (tab === "accounts")
      return (
        <Accounts trading={trading} catalog={catalog} onRefresh={onRefresh} />
      );
    if (tab === "journal") return <Journal trading={trading} onRefresh={onRefresh} />;
    if (tab === "analytics") return <Analytics trading={trading} filtersOpen={filtersOpen} />;
    if (tab === "logs") return <Logs />;
    if (tab === "backups") return <Backups />;
    if (tab === "mcp") return <Mcp />;
    return (
      <System
        catalog={catalog}
        systemStatus={systemStatus}
        onRefresh={onRefresh}
      />
    );
  }, [catalog, filtersOpen, onRefresh, systemStatus, tab, trading]);

  return (
    <section className="operations-workspace" aria-label={ariaLabel}>
      {(title || description) && (
        <header className="operations-workspace-header">
          <div>
            <Badge variant="secondary">TSX Core</Badge>
            {title && <h2>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
        </header>
      )}
      {availableTabs.length > 1 && (
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as OperationTab)}
          className="operations-tabs"
        >
          <TabsList
            variant="line"
            className="operations-tab-list"
            aria-label="Betriebsbereiche"
          >
            {availableTabs.map((tabId) => OPERATION_TABS.get(tabId)).filter(Boolean).map((item) => {
              if (!item) return null;
              const Icon = item.icon;
              return (
                <TabsTrigger key={item.id} value={item.id}>
                  <Icon />
                  <span><strong>{item.label}</strong><small>{item.description}</small></span>
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>
      )}
      <div className="operations-content">{content}</div>
    </section>
  );
}
