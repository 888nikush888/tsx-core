import { useCallback, useState } from 'react';
import { flushSync } from 'react-dom';
import { Plus } from 'lucide-react';
import { jsonRequest } from '@/lib/api';
import { Link, useSearchParams } from '@/lib/navigation';
import { usePoll } from '@/shared/api/use-poll';
import { useVersionedDraft } from '@/shared/forms/use-versioned-draft';
import { useConfirmationDialog } from '@/components/confirmation-dialog';
import { showIssuedCredential } from '@/shared/components/issued-credential';
import { Empty, time } from '@/shared/components/operator-primitives';
export function Mcp() {
  const [params, setParams] = useSearchParams();
  const query = new URLSearchParams(params); query.set('view', 'operator'); const queryKey = query.toString();
  const [snapshotState, setSnapshot] = useState<any>(null);
  const snapshot = snapshotState?.key === queryKey ? snapshotState.value : null;
  const [error, setError] = useState("");
  const [notice, setNotice] = useState('');
  const selectedId = params.get('agentId') || '';
  const setSelectedId = (id: string) => setParams(previous => { if (id) previous.set('agentId', id); else previous.delete('agentId'); return previous; });
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState("");

  const { confirm, confirmationDialog } = useConfirmationDialog();
  const emptyAgentForm = {
    name: "",
    permissions: [] as string[],
    eventSubscriptions: [] as string[],
    enabled: true,
  };
  const selected = snapshot?.selectedAgent || snapshot?.agents?.find((agent: any) => agent.id === selectedId) || null;
  const serverForm = selected ? { name: selected.name, permissions: selected.permissions as string[], eventSubscriptions: selected.eventSubscriptions as string[], enabled: selected.enabled as boolean } : null;
  const draft = useVersionedDraft(selectedId, serverForm, selected?.updatedAt ?? null, emptyAgentForm);
  const { draft: form, setDraft: setForm } = draft;
  const load = useCallback(async () => {
    try {
      setSnapshot({ key: queryKey, value: await jsonRequest(`/api/mcp?${queryKey}`) });
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [queryKey]);
  const readMcp = useCallback(async (signal: AbortSignal) => ({ key: queryKey, value: await jsonRequest(`/api/mcp?${queryKey}`, { signal }) }), [queryKey]);
  usePoll(readMcp, (value) => { setSnapshot(value); setError(""); }, (reason) => setError(reason.message), 3_000);
  const call = async (
    key: string,
    url: string,
    body: unknown,
    confirmation?: string,
    method = "POST",
  ) => {
    setBusy(key);
    setError("");
    setNotice('');
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
      if (result?.token) showIssuedCredential("MCP-Agent-Token", result.token);
      setNotice('Änderung bestätigt. Laufzeit, Agentenrechte und konkrete Ausführung bleiben getrennte Nachweise.');
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
    if (!await confirm({
      title: "MCP-Laufzeit ändern",
      description: `Die MCP-Laufzeit wird auf „${mode}“ gesetzt.`,
      confirmLabel: "Modus ändern",
      destructive: mode === "disabled",
    })) return;
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
  const canLeaveDraft = async () => {
    if (!draft.dirty) return true;
    if (!await confirm({ title: "Ungespeicherte Änderungen verwerfen", description: "Der Agentenentwurf wurde noch nicht gespeichert.", confirmLabel: "Verwerfen", destructive: true })) return false;
    // Complete the approved discard before URL navigation consults the shared dirty guard.
    flushSync(() => { if (serverForm) draft.acceptServer(); else draft.saved(emptyAgentForm, null); });
    return true;
  };
  const pageControls = (kind: string, label: string) => <div className="flex gap-3"><button className="secondary-button" disabled={draft.dirty || !params.has(`${kind}Cursor`)} onClick={() => setParams(previous => { previous.delete(`${kind}Cursor`); return previous; })}>Erste {label}</button><button className="secondary-button" disabled={draft.dirty || !snapshot?.pages?.[kind]?.hasMore} onClick={() => setParams(previous => { previous.set(`${kind}Cursor`, snapshot.pages[kind].nextCursor); return previous; })}>Weitere {label}</button></div>;
  const startNew = async () => {
    if (!await canLeaveDraft()) return;
    setCreating(true);
    setSelectedId("");
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
    if (draft.conflict) { setError("Der Agent wurde geändert. Zuerst vergleichen und den Konflikt auflösen."); return; }
    const result = selected
      ? await call("save-agent", "/api/mcp/agents/update", {
          id: selected.id,
          baseUpdatedAt: draft.baseRevision,
          ...form,
        })
      : await call("create-agent", "/api/mcp/agents", form);
    if (result?.agent) flushSync(() => draft.saved(form, result.agent.updatedAt));
    if (!selected && result?.token) {
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
    if (!selected || !await confirm({
      title: "Agent-Token rotieren",
      description: `Der Token von „${selected.name}“ wird ersetzt und alle bestehenden Sitzungen werden getrennt.`,
      confirmLabel: "Token rotieren",
      destructive: true,
    })) return;
    await call(
      "rotate-agent",
      "/api/mcp/agents/rotate",
      { id: selected.id },
      "rotate-mcp-agent-token",
    );
  };
  const remove = async () => {
    if (!selected || !await confirm({
      title: "MCP-Agent widerrufen",
      description: `Agent „${selected.name}“ wird endgültig gelöscht und verliert sofort seinen Zugriff.`,
      confirmationText: "DELETE",
      confirmLabel: "Agent löschen",
      destructive: true,
    })) return;
    const result = await call(
      "delete-agent",
      "/api/mcp/agents",
      { id: selected.id },
      "delete-mcp-agent",
      "DELETE",
    );
    if (result) {
      flushSync(() => draft.saved(emptyAgentForm, null));
      setSelectedId("");
      setCreating(false);
    }
  };
  const decide = async (proposal: any, approve: boolean) => {
    const reason = approve ? undefined : await confirm({
      title: "MCP-Vorschlag ablehnen",
      description: `Der Vorschlag „${proposal.action}“ wird nicht ausgeführt.`,
      inputLabel: "Ablehnungsgrund",
      inputRequired: true,
      confirmLabel: "Ablehnen",
      destructive: true,
    });
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
      {confirmationDialog}
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
      {notice && <p role="status">{notice}</p>}
      {snapshot?.interpretation && <p>{snapshot.interpretation}</p>}
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

      <section className="operations-card">
        <h3>Agenten</h3>
        <div className="agent-grid">
          {snapshot?.agents?.map((agent: any) => (
            <button
              type="button"
              key={agent.id}
              className={selectedId === agent.id ? "selected" : ""}
              onClick={async () => {
                if (agent.id !== selectedId && !await canLeaveDraft()) return;
                setCreating(false);
                setSelectedId(agent.id);
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
        {pageControls('agents', 'Agenten')}
      </section>
      {showEditor && (
        <section className="operations-card mcp-editor">
          <h3>{selected ? "Agent bearbeiten" : "Agent erstellen"}</h3>
          {draft.dirty && <p role="status">Ungespeicherte Änderungen · automatische Aktualisierung erhält diesen Entwurf.</p>}
          {draft.conflict && <div role="alert" className="builder-error">
            <p>Der Serverstand wurde geändert. Speichern ist bis zum Vergleich gesperrt.</p>
            <dl><dt>Server</dt><dd>{serverForm?.name} · {serverForm?.enabled ? "aktiv" : "inaktiv"} · Rechte: {serverForm?.permissions.join(", ")} · Ereignisse: {serverForm?.eventSubscriptions.join(", ")}</dd>
              <dt>Entwurf</dt><dd>{form.name} · {form.enabled ? "aktiv" : "inaktiv"} · Rechte: {form.permissions.join(", ")} · Ereignisse: {form.eventSubscriptions.join(", ")}</dd></dl>
            <button type="button" className="secondary-button" onClick={draft.acceptServer}>Entwurf verwerfen und Server übernehmen</button>
            <button type="button" className="secondary-button" onClick={draft.rebase}>Verglichen: Entwurf auf neuen Stand anwenden</button>
          </div>}
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
              disabled={Boolean(busy) || !form.name.trim() || draft.conflict}
              onClick={() => void save()}
            >
              Speichern
            </button>
          </div>
        </section>
      )}
      <section className="operations-card">
        <h3>Freigabe-Warteschlange</h3>
        <label>Vorschlagsstatus<select className="border bg-background p-2" disabled={draft.dirty} value={params.get('proposalsStatus') || 'pending'} onChange={event => setParams(previous => { previous.set('proposalsStatus', event.target.value); previous.delete('proposalsCursor'); return previous; })}>{['pending', 'approved', 'executing', 'completed', 'rejected', 'failed', 'expired', 'all'].map(status => <option key={status}>{status}</option>)}</select></label>
        {snapshot?.proposals
          ?.map((proposal: any) => (
            <div className="proposal-row" key={proposal.id}>
              <div>
                <strong>{proposal.action}</strong>
                <small>
                  {proposal.agentName} · {proposal.status} · bis {time(proposal.expiresAt)}
                </small>
                {proposal.preflight?.blockers?.map((item: string) => (
                  <small className="error-text" key={item}>
                    {item}
                  </small>
                ))}
              </div>
              <div>
                <Link to={`/integrations/mcp/proposals/${encodeURIComponent(proposal.id)}`} className="secondary-button">Prüfen & entscheiden</Link>
                <button
                  type="button"
                  disabled={Boolean(busy) || proposal.status !== 'pending'}
                  onClick={() => void decide(proposal, false)}
                >
                  Ablehnen
                </button>
              </div>
            </div>
          ))}
        {!snapshot?.proposals?.length && <Empty text="Keine Vorschläge auf dieser Seite." />}
        {pageControls('proposals', 'Vorschläge')}
      </section>
      <section className="operations-card">
        <h3>Aktive Sitzungen & letzte Aktionen</h3>
        <div className="system-line">
          <span>Aktive Sitzungen</span>
          <strong>
            {snapshot?.activeSessionCount ?? 'unbekannt'}
          </strong>
        </div>
        {snapshot?.sessions?.map((session: any) => <p key={session.id}>{session.agentName || session.agentId} · {session.clientName} · {session.disconnectedAt == null ? 'verbunden' : 'getrennt'} · zuletzt {time(session.lastSeenAt)}</p>)}
        {pageControls('sessions', 'Sitzungen')}
        {snapshot?.actions?.map((action: any) => (
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
        {pageControls('actions', 'Aktionen')}
      </section>
    </div>
  );
}
