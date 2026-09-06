import { AccountPositionLimit } from "@/features/accounts/account-position-limit";
import { Empty, time } from "@/shared/components/operator-primitives";
import { useMemo, useState } from "react";
import { AlertTriangle, Plus } from "lucide-react";
import { jsonRequest } from "@/lib/api";
import { Link } from "@/lib/navigation";
import { useConfirmationDialog } from "@/components/confirmation-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ExchangeCatalog, TradingAccount, TradingSnapshot } from "@/app/workflow/types";
import { groupExchangeCatalog } from "@/app/workflow/exchange-catalog";
import { useDirtyGuard } from "@/shared/forms/use-dirty-guard";
import { useOperatorReadOnly } from "@/shared/api/operator-session";

export function Accounts({
  trading,
  catalog,
  onRefresh,
}: {
  trading: TradingSnapshot | null;
  catalog: ExchangeCatalog | null;
  onRefresh: () => Promise<void>;
}) {
  const readOnly = useOperatorReadOnly();
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
  useDirtyGuard(Boolean(creating && (form.name || form.initialBalance !== '10000' || form.maxConcurrentPositions !== 20 || Object.values(form.credentials).some(Boolean))) || Object.values(replacement).some(Boolean));
  const [releaseTarget, setReleaseTarget] = useState<TradingAccount | null>(null);
  const [releaseConfirmation, setReleaseConfirmation] = useState("");
  const { confirm, confirmationDialog } = useConfirmationDialog();
  const exchange = catalog?.exchanges.find((item) => item.id === form.exchange);
  const catalogGroups = useMemo(
    () => (catalog ? groupExchangeCatalog(catalog) : null),
    [catalog],
  );
  const openIncidents = (trading?.accountIncidents || []).filter((incident) => incident.status === "open");

  const observeAccepted = async () => {
    setMessage(previous => previous || 'Command bestätigt. Tatsächlichen Kontostand und verbleibende Freigaben prüfen.');
    try { await onRefresh(); }
    catch (reason) { setMessage(previous => `${previous} Nachladen fehlgeschlagen: ${reason instanceof Error ? reason.message : String(reason)}. Keine automatische Wiederholung.`); }
  };

  const probeCandidate = async (exchangeId: string) => {
    if (readOnly) return;
    setBusy(`probe:${exchangeId}`);
    setMessage("");
    try {
      await jsonRequest("/api/exchanges/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exchange: exchangeId }),
      });
      setMessage("Öffentlicher Kompatibilitätstest abgeschlossen. Eine Zertifizierung erfolgt dadurch nicht automatisch.");
      await observeAccepted();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };

  const updateAccount = async (
    account: TradingAccount,
    change: Record<string, unknown>,
  ) => {
    if (readOnly) return;
    setBusy(account.id);
    setMessage("");
    try {
      const result = await jsonRequest("/api/trading/accounts/configuration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: account.id, ...change }),
      });
      await observeAccepted();
      return result;
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
    if (!releaseTarget || readOnly) return;
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
      await observeAccepted();
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
    if (readOnly) return;
    if (action === "delete" && !await confirm({
      title: "Konto entfernen",
      description: `„${account.name}“ wird aus dem aktiven Setup entfernt. Abgeschlossene Trades, Abgleiche und Incidents bleiben für Journal und Audit erhalten. Offene Positionen, Orders oder aktive Builder-Pfade verhindern die Entfernung.`,
      confirmationText: "KONTO ENTFERNEN",
      confirmLabel: "Konto entfernen",
      destructive: true,
    })) return;
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
      await observeAccepted();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };

  const replaceCredentials = async (account: TradingAccount) => {
    if (readOnly) return;
    if (!await confirm({ title: 'Zugangsdaten wechseln · globale Handelssperre',
      description: `Die Zugangsdaten für „${account.name}“ werden ersetzt. Der Server deaktiviert GLOBAL neue Entries und aktiviert den globalen Kill-Switch. Dieses Konto bleibt nach der Rotation deaktiviert. Verifizierung, Kontofreigabe und globale Wiederfreigabe sind getrennte Schritte.`,
      confirmLabel: 'Zugangsdaten ersetzen', destructive: true })) return;
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
      await observeAccepted();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };

  const create = async () => {
    if (readOnly) return;
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
      await observeAccepted();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <div className="operations-stack">
      {confirmationDialog}
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
          disabled={!catalogGroups || catalogGroups.creatable.length === 0}
          onClick={() => setCreating((value) => !value)}
        >
          <Plus size={15} /> Konto
        </button>
      </div>
      {!catalogGroups && (
        <div className="account-warning">
          <AlertTriangle size={15} />
          <span>Exchange-Katalog nicht erreichbar. Bestehende Konten bleiben davon unberührt; neue Konten sind gesperrt.</span>
        </div>
      )}
      {catalogGroups && (
        <div className="exchange-catalog-groups">
          <section className="operations-card">
            <h4>Zertifiziert</h4>
            {catalogGroups.certified.map((item) => (
              <div className="system-line" key={item.id}>
                <span>{item.name}</span>
                <strong>{item.modes.join(" · ")}</strong>
              </div>
            ))}
          </section>
          <section className="operations-card">
            <h4>Kandidaten</h4>
            {catalogGroups.candidates.map((item) => (
              <div className="system-line" key={item.id}>
                <span>{item.name}</span>
                <Button
                  type="button"
                  variant="outline"
                  disabled={Boolean(busy)}
                  onClick={() => void probeCandidate(item.id)}
                >
                  {busy === `probe:${item.id}` ? "Prüfe…" : "Öffentlich testen"}
                </Button>
              </div>
            ))}
            {catalogGroups.candidates.length === 0 && <Empty text="Keine Kandidaten." />}
          </section>
          <section className="operations-card">
            <h4>Weitere / nicht kompatibel</h4>
            {catalogGroups.others.map((item) => (
              <div className="system-line" key={item.id}>
                <span>{item.name} · {item.status}</span>
                <strong>{item.reason || "Noch nicht für TSX zertifiziert"}</strong>
              </div>
            ))}
            {catalogGroups.others.length === 0 && <Empty text="Keine weiteren Einträge." />}
          </section>
        </div>
      )}
      {message && (
        <div className="builder-error">
          <AlertTriangle size={16} />
          {message}
        </div>
      )}
      <section className="operations-card account-incident-overview" aria-label="Offene Konto-Incidents">
        <div className="operations-section-heading">
          <div>
            <h3>Offene Konto-Incidents</h3>
            <p>
              Warnungen werden bei einem sauberen Kontoabgleich automatisch gelöst. Bei einer Kontosperre zuerst abgleichen und anschließend „Prüfen &amp; freigeben“ verwenden.
            </p>
          </div>
          <Badge variant={openIncidents.some((incident) => incident.severity === "critical") ? "destructive" : "outline"}>
            {openIncidents.length} offen
          </Badge>
        </div>
        {openIncidents.map((incident) => {
          const account = trading?.accounts.find((candidate) => candidate.id === incident.accountId);
          return (
            <div className="account-incident" key={`overview-${incident.id}`}>
              <div>
                <strong>{account?.name || incident.accountId} · {incident.message}</strong>
                <small>{incident.category} · {incident.occurrenceCount} Beobachtungen · zuletzt {time(incident.lastSeenAt)}</small>
              </div>
              <div className="incident-actions">
                <Badge variant={incident.severity === "critical" ? "destructive" : "outline"}>
                  {incident.severity === "critical" ? "kritisch" : "Warnung"}
                </Badge>
                {account && (
                  <Button type="button" variant="outline" size="sm" disabled={busy === account.id} onClick={() => void accountAction(account, "reconcile")}>
                    Abgleichen
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        {openIncidents.length === 0 && <Empty text="Keine offenen Konto-Incidents." />}
      </section>
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
              {catalogGroups?.creatable.map((item) => (
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
                required={field.required}
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
              <strong><Link to={`/trading/accounts/${encodeURIComponent(account.id)}`}>{account.name}</Link></strong>
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
              onSave={(maximum, baseUpdatedAt) =>
                updateAccount(account, { maxConcurrentPositions: maximum, baseUpdatedAt })
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
