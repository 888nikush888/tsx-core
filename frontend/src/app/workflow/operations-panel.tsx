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
import { apiFetch, clearDashboardToken, setDashboardToken } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ExchangeCatalog, TradingAccount, TradingSnapshot } from "./types";

type OperationsPanelProps = {
  open: boolean;
  trading: TradingSnapshot | null;
  catalog: ExchangeCatalog | null;
  systemStatus: Record<string, any> | null;
  onClose: () => void;
  onRefresh: () => Promise<void>;
};

type OperationTab =
  | "overview"
  | "accounts"
  | "journal"
  | "analytics"
  | "logs"
  | "backups"
  | "mcp"
  | "system";

const TABS: Array<{ id: OperationTab; label: string; icon: typeof Activity }> =
  [
    { id: "overview", label: "Live", icon: Activity },
    { id: "accounts", label: "Konten", icon: Landmark },
    { id: "journal", label: "Journal", icon: Gauge },
    { id: "analytics", label: "Analyse", icon: BarChart3 },
    { id: "logs", label: "Logs", icon: Terminal },
    { id: "backups", label: "Backups", icon: DatabaseBackup },
    { id: "mcp", label: "MCP", icon: Bot },
    { id: "system", label: "System", icon: ServerCog },
  ];

async function requestJson(url: string, init?: RequestInit) {
  const response = await apiFetch(url, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      payload.error || `Anfrage fehlgeschlagen (${response.status}).`,
    );
  return payload;
}

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
  const mutate = async (key: string, url: string, body: unknown) => {
    setBusy(key);
    setMessage("");
    try {
      await requestJson(url, {
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
      <div className="operations-metrics">
        <Metric label="Aktive Pfade" value={overview?.enabledRouteCount ?? 0} />
        <Metric
          label="Offene Positionen"
          value={overview?.openPositionCount ?? 0}
        />
        <Metric
          label="Wartende Intents"
          value={overview?.pendingIntentCount ?? 0}
        />
        <Metric
          label="Unklare Orders"
          value={overview?.unknownOrderCount ?? 0}
          danger={(overview?.unknownOrderCount ?? 0) > 0}
        />
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
  const exchange = catalog?.exchanges.find((item) => item.id === form.exchange);

  const updateAccount = async (
    account: TradingAccount,
    change: Record<string, unknown>,
  ) => {
    setBusy(account.id);
    setMessage("");
    try {
      await requestJson("/api/trading/accounts/configuration", {
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
    if (
      window.prompt(
        "Kontosperre erst nach zwei erzwungenen Börsenabgleichen freigeben. RELEASE ACCOUNT KILL SWITCH exakt eingeben:",
      ) !== "RELEASE ACCOUNT KILL SWITCH"
    )
      return;
    await updateAccount(account, {
      killSwitchActive: false,
      killSwitchReason: null,
      confirmation: "RELEASE ACCOUNT KILL SWITCH",
    });
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
      await requestJson(request[0], {
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
      await requestJson("/api/trading/accounts/credentials", {
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
      await requestJson("/api/trading/accounts", {
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
          <button
            type="button"
            className="primary-button"
            disabled={busy === "create" || !form.name.trim()}
            onClick={create}
          >
            {busy === "create" ? "Prüfe…" : "Konto anlegen & verifizieren"}
          </button>
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
  );
}

function Journal() {
  const [entries, setEntries] = useState<any[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(
    () =>
      requestJson("/api/trading/journal?limit=200")
        .then((payload) => setEntries(payload.entries || []))
        .catch((reason) => setError(reason.message)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="operations-stack">
      <div className="operations-section-heading">
        <div>
          <h3>Trade Journal</h3>
          <p>Signal, Pfad, Konto und Ergebnis in einer Spur.</p>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => void load()}
        >
          <RefreshCw size={16} />
        </button>
      </div>
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

function Analytics({ trading }: { trading: TradingSnapshot | null }) {
  const channels = trading?.channelAnalytics?.channels || [];
  const exchanges = trading?.channelAnalytics?.exchanges || [];
  const adaptiveStates = trading?.workflowAdaptiveRisk?.states || [];
  const evaluations = trading?.workflowAdaptiveRisk?.evaluations || [];
  const execution = trading?.executionAnalytics || {};
  const totalPnl = channels.reduce(
    (total, item: any) => total + Number(item.realizedPnl || 0),
    0,
  );
  const closedTrades = channels.reduce(
    (total, item: any) => total + Number(item.closedTrades || 0),
    0,
  );
  const peakDrawdown = (trading?.channelAnalytics?.equity || []).reduce(
    (peak, point: any) => Math.max(peak, Number(point.drawdownPercent || 0)),
    0,
  );
  return (
    <div className="operations-stack">
      <div className="operations-section-heading">
        <div>
          <h3>Trading-Analyse</h3>
          <p>
            Kanal-, Konto- und Ausführungsleistung aus persistierten Messwerten.
          </p>
        </div>
      </div>
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
        {evaluations.slice(0, 30).map((item: any) => (
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
    </div>
  );
}

function Logs() {
  const [entries, setEntries] = useState<
    Array<{ cursor: number; line: string }>
  >([]);
  const cursor = useRef(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    let alive = true;
    const poll = async () => {
      try {
        const payload = await requestJson(
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
  return (
    <div className="operations-stack">
      <div className="operations-section-heading">
        <div>
          <h3>Live Logs</h3>
          <p>
            Cursor {cursor.current} · {entries.length} Zeilen lokal
          </p>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={() => setPaused((value) => !value)}
        >
          {paused ? "Fortsetzen" : "Pausieren"}
        </button>
      </div>
      <div className="compact-log" role="log">
        {entries.map((entry) => (
          <div key={entry.cursor}>
            <span>{entry.cursor}</span>
            {entry.line}
          </div>
        ))}
        {entries.length === 0 && <Empty text="Warte auf Log-Einträge …" />}
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
      requestJson("/api/backups")
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
      const result = await requestJson("/api/operations/backup", {
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
      await requestJson(`/api/backups/verify?name=${encodeURIComponent(name)}`);
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
      await requestJson("/api/backups/restore", {
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
      const payload = await requestJson("/api/backups/recover-offsite", {
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
      setSnapshot(await requestJson("/api/mcp"));
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
      const result = await requestJson(url, {
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
  const [secretInput, setSecretInput] = useState<Record<string, string>>({});
  const [loginValue, setLoginValue] = useState("");
  const [loginName, setLoginName] = useState({ firstName: "", lastName: "" });
  const [issuedToken, setIssuedToken] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const [configuration, runtimePayload, secretPayload, recoveryPayload] =
      await Promise.all([
        requestJson("/api/config"),
        requestJson("/api/runtime-settings"),
        requestJson("/api/secrets"),
        requestJson("/api/recovery"),
      ]);
    setConfig(configuration);
    setRuntime(runtimePayload.settings);
    setSecrets(secretPayload.secrets);
    setRecovery(recoveryPayload);
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
        await requestJson("/api/config", {
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
          await requestJson("/api/secrets", {
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
        const payload = await requestJson("/api/runtime-settings", {
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
        requestJson("/api/control", {
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
        requestJson("/api/telegram-login", {
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
        requestJson("/api/access-tokens", {
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
        requestJson("/api/restart", {
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
    </div>
  );
}

export function OperationsPanel({
  open,
  trading,
  catalog,
  systemStatus,
  onClose,
  onRefresh,
}: OperationsPanelProps) {
  const [tab, setTab] = useState<OperationTab>("overview");
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
    if (tab === "journal") return <Journal />;
    if (tab === "analytics") return <Analytics trading={trading} />;
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
  }, [catalog, onRefresh, systemStatus, tab, trading]);
  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="operations-panel sm:max-w-3xl"
        closeLabel="Betriebszentrale schließen"
      >
        <SheetHeader>
          <Badge variant="secondary">Betriebszentrale</Badge>
          <SheetTitle id="operations-panel-title">
            {TABS.find((item) => item.id === tab)?.label}
          </SheetTitle>
          <SheetDescription>
            Live-Status, Börsenkonten, Auswertung und sichere Systemverwaltung.
          </SheetDescription>
        </SheetHeader>
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
            {TABS.map((item) => {
              const Icon = item.icon;
              return (
                <TabsTrigger key={item.id} value={item.id}>
                  <Icon />
                  <span>{item.label}</span>
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>
        <div className="operations-content">{content}</div>
      </SheetContent>
    </Sheet>
  );
}
