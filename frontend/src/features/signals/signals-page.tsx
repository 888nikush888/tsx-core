import { IngressRelations } from './ingress-relations';
import { useCallback, useState } from "react";
import { jsonRequest, mutateAndObserve } from "@/lib/api";
import { Link, useSearchParams } from "@/lib/navigation";
import { usePoll } from "@/shared/api/use-poll";
import { useConfirmationDialog } from "@/components/confirmation-dialog";
import { EvidenceFields } from "@/shared/components/evidence";

export function SignalsPage({ kind, readOnly = true }: { kind: "ingress" | "processed" | "outbox" | "messages"; readOnly?: boolean }) {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const channelId = params.get("channelId") ?? "";
  const cursor = params.get("cursor") ?? "";
  const objectId = params.get('objectId') ?? '';
  const messageId = params.get('messageId') ?? '';
  const query = new URLSearchParams({ status, channelId, cursor, objectId, messageId, limit: "50" }).toString();
  const [page, setPage] = useState<any>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [refresh, setRefresh] = useState(0);
  const { confirm, confirmationDialog } = useConfirmationDialog();
  const endpoint = kind === "outbox" ? "/api/outbox/page" : `/api/signals/${kind}`;
  const read = useCallback(async (signal: AbortSignal) => ({ query, kind, payload: await jsonRequest(`${endpoint}?${query}`, { signal }) }), [query, kind, endpoint]);
  usePoll(read, (value) => { setPage(value); setError(""); }, (reason) => setError(reason.message), 5000, refresh);
  const current = page?.query === query && page?.kind === kind ? page.payload : null;
  const changeFilter = (key: string, value: string) => setParams((previous) => { if (value) previous.set(key, value); else previous.delete(key); previous.delete("cursor"); return previous; }, { replace: true });
  const command = async (task: any, action: "retry" | "acknowledge") => {
    if (readOnly) return;
    const answer = await confirm(action === "retry" ? {
      title: "Versand ausdrücklich wiederholen", description: `Auftrag ${task.id}, Ziel ${task.targetChatId ?? "unbekannt"}, Status ${task.status}. Bei unbekanntem Ausgang kann die Nachricht bereits zugestellt sein. Eine Wiederholung kann einen Doppelversand auslösen.`,
      confirmationText: "DOPPELVERSAND MÖGLICH", confirmLabel: "Wiederholung beauftragen", destructive: true,
    } : { title: "Unbekannten Versand quittieren", description: `Auftrag ${task.id} wird als durch den Operator abgeglichen markiert. Die Quittierung ist kein Telegram-Zustellbeleg.`, inputLabel: "Abgleichgrund (mindestens 10 Zeichen)", inputRequired: true, confirmLabel: "Quittieren" });
    if (!answer) return;
    if (action === "acknowledge" && String(answer).trim().length < 10) { setError("Der Abgleichgrund benötigt mindestens 10 Zeichen."); return; }
    setBusy(task.id); setMessage("");
    try {
      await mutateAndObserve(() => jsonRequest(`/api/outbox/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Destructive-Confirmation": action === "retry" ? "retry-unknown-delivery" : "acknowledge-unknown-delivery" },
        body: JSON.stringify({ id: task.id, ...(action === "acknowledge" ? { reason: answer } : {}) }),
      }), () => setMessage(action === "retry" ? "Wiederholung angenommen; tatsächlichen Versandstatus weiter beobachten." : "Operatorquittierung bestätigt. Keine bestätigte Zustellung daraus ableiten."), async () => { setRefresh((value) => value + 1); });
    } catch (reason) { setError(`Aktion nicht bestätigt; keine automatische Wiederholung: ${reason instanceof Error ? reason.message : String(reason)}`); }
    finally { setBusy(""); }
  };
  return <div className="operations-stack">{confirmationDialog}<h1>{kind === "outbox" ? "Versand & Outbox" : kind === "ingress" ? "Dauerhafter Eingang & Alben" : kind === 'messages' ? 'Gespeicherte Nachrichten' : "Parserergebnisse"}</h1>
    {kind === 'ingress' && <Link to="/signals/cache">Nachrichtenspeicher einschließlich älterer Eingänge öffnen</Link>}
    <section className="operations-card system-form"><div className="builder-field-grid"><label>Kanal<input value={channelId} onChange={(event) => changeFilter("channelId", event.target.value)} /></label>
      <label>Objekt-ID<input maxLength={256} value={objectId} onChange={event => changeFilter('objectId', event.target.value)} /></label>
      <label>Original-Nachrichten-ID<input inputMode="numeric" maxLength={16} value={messageId} onChange={event => changeFilter('messageId', event.target.value)} /></label>
      {['ingress', 'outbox'].includes(kind) && <label>Status<select value={status} onChange={(event) => changeFilter("status", event.target.value)}><option value="">Alle</option>{(current?.states ?? (kind === "outbox" ? ["pending", "preparing", "sending", "completed", "failed", "unknown", "needs_review"] : ["pending", "routed", "filtered", "album_waiting", "needs_review"])).map((value: string) => <option key={value}>{value}</option>)}</select></label>}</div>
      <button className="secondary-button" onClick={() => setParams(new URLSearchParams())}>Filter zurücksetzen</button></section>
    {error && <p role="alert">{error} · Anzeige möglicherweise veraltet.</p>}{message && <p role="status">{message}</p>}
    {current ? <><p>{current.entries.length} Einträge auf dieser Seite · {current.hasMore ? "weitere vorhanden" : "Ende der Auswahl"} · Beobachtung {new Date(current.observedAt).toLocaleString("de-DE")}</p>
      {current.entries.map((entry: any) => <article className="operations-card" key={entry.id}><h2>{kind !== 'outbox' ? <Link to={`/signals/${kind === 'ingress' ? 'messages' : kind === 'messages' ? 'cache' : 'processed'}/${encodeURIComponent(entry.id)}`}>{entry.id}</Link> : entry.id}</h2>
        <EvidenceFields fields={[["Kanal / Nachricht", `${entry.channelId} / ${entry.messageId ?? "Album"}`], ["Status", entry.status ?? "Parserergebnis gespeichert"], ["Originalrevision", entry.workflowRevisionId], ["Erstellt", new Date(entry.createdAt).toLocaleString("de-DE")],
          ...(kind === "outbox" ? [["Gepinntes Ziel", entry.targetChatId], ["Versuche", entry.attempts], ["Abschlussart", entry.resultMode], ["Bestätigte Nachrichten-IDs", entry.confirmedMessageIds], ["Grund", entry.reason]] as Array<[string, string | number]> : [["Parser / Modell", `${entry.parserVersion ?? "nicht verfügbar"} / ${entry.model ?? "nicht verfügbar"}`], ["Grund", entry.reason]] as Array<[string, string]>)]} />
        {kind === "outbox" && <div className="system-actions">{["failed", "unknown"].includes(entry.status) && <button className="danger-button" disabled={readOnly || Boolean(busy)} onClick={() => void command(entry, "retry")}>Wiederholung prüfen</button>}{entry.status === "unknown" && <button className="secondary-button" disabled={readOnly || Boolean(busy)} onClick={() => void command(entry, "acknowledge")}>Quittieren</button>}{entry.status === "needs_review" && <p>Originalnachweise ungeklärt. Kein automatischer Retry und keine Freigabe zum Überspringen der Schutzgrenze.</p>}</div>}
        {kind === 'messages' && <p className="whitespace-pre-wrap">{entry.excerpt}</p>}
      </article>)}{!current.entries.length && <p>Keine Einträge für diese Auswahl.</p>}
      <div className="system-actions"><button className="secondary-button" disabled={!cursor} onClick={() => changeFilter("cursor", "")}>Erste Seite</button><button className="secondary-button" disabled={!current.hasMore} onClick={() => setParams((previous) => { previous.set("cursor", current.nextCursor); return previous; })}>Nächste Seite</button></div></> : <p role="status">Auswahl wird geladen …</p>}
  </div>;
}

export function IngressDetail({ id }: { id: string }) {
  const [detail, setDetail] = useState<any>(null);
  const [error, setError] = useState("");
  const read = useCallback((signal: AbortSignal) => jsonRequest(`/api/signals/ingress/detail?id=${encodeURIComponent(id)}`, { signal }), [id]);
  usePoll(read, (value) => { setDetail(value); setError(""); }, (reason) => setError(reason.message));
  return <div className="operations-stack"><Link to="/signals/messages">Eingang</Link><h1>Nachricht {id}</h1>{error && <p role="alert">{error}</p>}{detail && <>
    <section className="operations-card"><h2>Quelle und gepinnte Auswahl</h2><EvidenceFields fields={[["Kanal", detail.work.channelId], ["Telegram-ID", detail.work.messageId], ["Workflowrevision", detail.work.workflowRevisionId], ["Eingangsstatus", detail.work.status], ["Grund", detail.work.reason], ["Quelltext (redigiert, maximal 10.000 Zeichen)", detail.source?.excerpt]]} /></section>
    {detail.source?.id && <section className="operations-card"><Link to={`/signals/cache/${detail.source.id}`}>Gespeicherten Nachrichtentext öffnen</Link></section>}
    <IngressRelations id={id} />
  </>}</div>;
}
