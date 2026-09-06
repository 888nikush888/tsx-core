import { TradeRelations } from './trade-relations';
import { useCallback, useState } from "react";
import { jsonRequest, mutateAndObserve } from "@/lib/api";
import { Link } from "@/lib/navigation";
import { usePoll } from "@/shared/api/use-poll";
import { useVersionedDraft } from "@/shared/forms/use-versioned-draft";
import { EvidenceFields, EvidenceTable } from "@/shared/components/evidence";
import { MoneyAmount, MoneySummaryAmount } from "@/app/workflow/money-amount";

const emptyReview = { notes: "", tags: [] as string[], rating: null as number | null, reviewed: false };
const reviewFields = (value: typeof emptyReview) => ({ notes: value.notes, tags: value.tags, rating: value.rating, reviewed: value.reviewed });
const displayTime = (value: unknown) => typeof value === "number" ? new Date(value).toLocaleString("de-DE") : "nicht verfügbar";

export function TradeDetail({ intentId, readOnly = true }: { intentId: string; readOnly?: boolean }) {
  const [entry, setEntry] = useState<any>(null);
  const [safety, setSafety] = useState<any>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [observedAt, setObservedAt] = useState<number | null>(null);
  const read = useCallback((signal: AbortSignal) => jsonRequest(`/api/trading/intents/detail?id=${encodeURIComponent(intentId)}`, { signal }), [intentId]);
  usePoll(read, (payload) => { setEntry(payload.entry); setSafety(payload.safety ?? null); setObservedAt(payload.observedAt); setError(""); }, (reason) => setError(reason.message));
  const review = entry?.intentId === intentId ? entry.review : null;
  const form = useVersionedDraft(intentId, review ? { notes: review.notes, tags: review.tags, rating: review.rating, reviewed: review.reviewed } : null, review?.updatedAt ?? null, emptyReview);
  const save = async () => {
    if (readOnly || form.conflict) return;
    if (form.draft.notes.length > 10_000 || form.draft.tags.length > 20 || form.draft.tags.some((tag) => !tag.trim() || tag.length > 40)) { setError("Maximal 10.000 Notizzeichen, 20 Tags mit jeweils 1–40 Zeichen."); return; }
    setBusy(true); setError("");
    try {
      const { refreshError } = await mutateAndObserve(() => jsonRequest("/api/trading/journal", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intentId, ...form.draft, baseReviewUpdatedAt: form.baseRevision }),
      }), (result) => {
        setMessage("Review gespeichert. Ausführungsdaten und gepinnter Handelsplan bleiben unverändert.");
        if (result.result?.review) { setEntry(result.result); form.saved(reviewFields(result.result.review), result.result.review.updatedAt); }
      }, async () => {
        const payload = await jsonRequest(`/api/trading/intents/detail?id=${encodeURIComponent(intentId)}`);
        setEntry(payload.entry); form.saved(reviewFields(payload.entry.review), payload.entry.review.updatedAt);
      });
      if (refreshError) setMessage(`Review gespeichert; Nachladen fehlgeschlagen: ${refreshError}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const current = entry?.intentId === intentId ? entry : null;
  if (!current) return <div className="operations-stack"><h1>Trade {intentId}</h1><p role={error ? "alert" : "status"}>{error || "Trade wird geladen …"}</p><Link to="/trading/journal">Zum Journal</Link></div>;
  const plan = current.plan ?? {};
  const leverage = plan.leverageDecision ?? {};
  return <div className="operations-stack">
    <div><Link to="/trading/journal">Journal</Link><h1>{current.symbol} · {current.side}</h1><p>Intent {current.intentId} · {current.status} · {current.exchange}/{current.mode} · beobachtet {displayTime(observedAt)}</p></div>
    {error && <p role="alert">{error} Anzeige möglicherweise veraltet.</p>}{message && <p role="status">{message}</p>}
    <section className="operations-card"><h2>Originalquelle und Versionen</h2><EvidenceFields fields={[
      ["Konto", <Link key="account" to={`/trading/accounts/${encodeURIComponent(current.accountId)}`}>{current.accountName}</Link>], ["Kanal", current.channelId],
      ["Signal-ID", current.signal.id ? <Link key="signal" to={`/signals/processed?objectId=${encodeURIComponent(current.signal.id)}`}>{current.signal.id}</Link> : null], ["Telegram-Nachricht", current.signal.sourceMessageId], ["Quelle (redigiert)", current.signal.sourceExcerpt],
      ["Workflowrevision", current.workflowRevisionId ? <Link key="revision" to={`/workflows/revisions/${encodeURIComponent(current.workflowRevisionId)}`}>{current.workflowRevisionId}</Link> : null], ["Pfad-ID", current.executionPathId ? <Link key="path" to={`/workflows/paths/${encodeURIComponent(current.executionPathId)}`}>{current.executionPathId}</Link> : null], ["Signallauf", current.signalRunId],
      ["Strategie", `${current.strategy.name} · Version ${current.strategy.version} · ${current.strategy.id}`], ["Strategiehash", current.strategy.configurationSha256],
      ["Parser / Modell", `${current.signal.parserVersion ?? "unbekannt"} / ${current.signal.model ?? "unbekannt"}`], ["Prompthash", current.signal.promptSha256],
      ["Signalvertrag", current.signal.contractVersionId], ["Vertragshash", current.signal.contractDefinitionSha256],
    ]} /><p>Ohne erhaltene ursprüngliche Vertragsbindung bleibt der Signalvertrag unbekannt. Das heutige Schemaprofil wird nicht als historische Vertragsversion ausgegeben.</p></section>
    <section className="operations-card"><h2>Gepinnter Plan und tatsächliche Position</h2><EvidenceFields fields={[
      ["Geplanter Einstieg", plan.entryPrice], ["Tatsächlicher Fill-Durchschnitt", current.position?.averageEntryPrice],
      ["Geplante Menge", plan.quantity], ["Offene Restmenge (Repository)", current.position?.quantity],
      ["Positionsstatus", current.position?.status], ["Gemeldeter Stop", current.position?.stopPrice],
      ["Aktueller Live-Mark", "nicht verfügbar in dieser Quelle"], ["Unrealisierter PnL", "nicht verfügbar in dieser Quelle"],
      ["Hebel angefordert / Quelle", leverage.requested == null ? "nicht verfügbar" : `${leverage.requested}× / ${leverage.requestedSource}`],
      ["Strategie-/Marktgrenze", `${leverage.strategyMaximum ?? "unbekannt"}× / ${leverage.marketMaximum ?? "unbekannt"}×`],
      ["Effektiver Hebel", leverage.effective ?? plan.leverage], ["Ursprünglicher Ablauf", displayTime(plan.entryExpiresAt)],
      ["Maximale Slippage (%)", plan.maxSlippagePercent], ["Preisgrenze", plan.entryPriceBoundary?.limitPrice],
      ["Preisreferenz", plan.entryPriceBoundary?.referencePrice], ["Preistick", plan.entryPriceBoundary?.priceTick],
      ["Blocker", current.blockReason], ["Fehler", current.error],
    ]} /><p>Ein gemeldeter Stop beweist keine aktuelle Stopdeckung. Order-ACK, Fills, Position und bestätigte Flatheit sind getrennte Nachweise.</p></section>
    {current.relatedRowsIncluded === false ? <section className="operations-card space-y-6"><h2>Orders und Fills</h2><TradeRelations intentId={intentId} kind="orders" /><TradeRelations intentId={intentId} kind="fills" /></section> : (<section className="operations-card"><h2>Orders und Fills</h2><EvidenceTable caption="Orders · ursprüngliche und ersetzte Generationen" rows={current.orders} columns={[["id", "Order-ID"], ["role", "Geplante Rolle"], ["status", "Orderstatus"], ["quantity", "Menge"], ["filledQuantity", "Kumulativ gefüllt"], ["price", "Preis"], ["triggerPrice", "Trigger"], ["reduceOnly", "Reduce-only"], ["error", "Fehler"]]} />
      <EvidenceTable caption="Einzelne Fillbelege" rows={current.fills} columns={[["id", "Fill-ID"], ["orderId", "Order-ID"], ["quantity", "Menge"], ["price", "Preis"], ["fee", "Gebühr"], ["feeAsset", "Originalwährung"]]} /></section>)}
    <section className="operations-card"><h2>Geld und FX</h2>{current.money ? <><MoneySummaryAmount summary={current.money} />
      <div className="space-y-3">{current.relatedRowsIncluded === false && <TradeRelations intentId={intentId} kind="money" />}{current.money.events.map((event: any) => <div key={event.id}><strong>{event.kind} · {event.id}</strong><p>Original: {event.amount} {event.asset ?? "unbekannte Währung"} · Reporting: <MoneyAmount value={event.reportingValue} amount={event.reportingAmount} currency={event.reportingCurrency} status={event.valuationStatus} /></p><p>Quelle: {event.source} · {displayTime(event.occurredAt)} · FX-Beleg: {event.valuationEvidenceId ?? "nicht verfügbar"}</p></div>)}</div></> : <p>Geldbewertung nicht verfügbar.</p>}</section>
    <section className="operations-card"><h2>Schutz und Eigentumsbelege</h2><EvidenceFields fields={[
      ['Aktueller Schutzbeleg', safety?.protection?.protected === true ? 'vorhanden' : 'nicht aktuell bewiesen'], ['Grund', safety?.protection?.reason],
      ['Belegzweck', safety?.protection?.proof?.purpose ?? safety?.protection?.noDuty?.noSendBasis], ['Prüfzeit', displayTime(safety?.protection?.proof?.evaluatedAt)],
      ['Erfassungsbeginn', displayTime(safety?.protection?.proof?.acquisitionStartedAt)], ['Beleghash', safety?.protection?.proof?.evidenceHash],
      ['Entry-Fills (Ledger)', safety?.ownership?.entryQuantity], ['Exit-Fills (Ledger)', safety?.ownership?.exitQuantity], ['Eigene Restmenge (Ledger)', safety?.ownership?.netQuantity], ['Eigentumsprüfung', safety?.ownershipReason],
    ]} /><p>Der Originalbeleg wird vom bestehenden Schutzmodell geprüft. Ledger-Restmenge allein beweist weder Börsenflatheit noch aktuelle Stopdeckung.</p>
      <EvidenceTable caption="Börsenoperationen dieses Trades (bis 100)" rows={safety?.operations?.entries ?? []} columns={[["id", "Operation"], ["kind", "Command"], ["generation", "Generation"], ["status", "Zustand"], ["requestHash", "Requesthash"], ["reason", "Grund"]]} /><Link to={`/trading/operations?intentId=${encodeURIComponent(intentId)}`}>Alle Operationsseiten öffnen</Link></section>
    <section className="operations-card"><h2>Lebenslauf</h2>{current.relatedRowsIncluded === false && <TradeRelations intentId={intentId} kind="events" />}<ol>{Object.entries(current.timeline).sort((a, b) => Number(a[1]) - Number(b[1])).map(([event, at]) => <li key={event}>{displayTime(at)} · {event}</li>)}</ol><p>Die Zeitleiste zeigt gespeicherte Ereigniszeitpunkte. Fehlende Schritte sind kein Erfolgsnachweis.</p></section>
    <section className="operations-card system-form"><h2>Review</h2>{readOnly && <p>Viewer: Ausführungsdaten und Review sind schreibgeschützt.</p>}
      {form.dirty && <p role="status">Ungespeicherter Reviewentwurf</p>}
      {form.conflict && <div role="alert"><p>Review wurde zwischenzeitlich geändert. Servernotiz: {review.notes || "leer"} · Tags: {review.tags.join(", ")} · Bewertung: {review.rating ?? "keine"} · {review.reviewed ? "geprüft" : "nicht geprüft"}</p><button onClick={form.acceptServer}>Serverstand übernehmen</button><button onClick={form.rebase}>Verglichen: Entwurf erneut anwenden</button></div>}
      <fieldset disabled={readOnly || busy}><label>Notizen<textarea maxLength={10000} value={form.draft.notes} onChange={(event) => form.setDraft({ ...form.draft, notes: event.target.value })} /></label>
        <label>Tags (ein Tag pro Zeile)<textarea value={form.draft.tags.join("\n")} onChange={(event) => form.setDraft({ ...form.draft, tags: event.target.value ? event.target.value.split("\n") : [] })} /></label>
        <label>Bewertung<select value={form.draft.rating ?? ""} onChange={(event) => form.setDraft({ ...form.draft, rating: event.target.value === "" ? null : Number(event.target.value) })}><option value="">Keine Bewertung</option>{[1, 2, 3, 4, 5].map((rating) => <option key={rating} value={rating}>{rating}</option>)}</select></label>
        <label><input type="checkbox" checked={form.draft.reviewed} onChange={(event) => form.setDraft({ ...form.draft, reviewed: event.target.checked })} />Geprüft</label>
        <button className="primary-button" disabled={form.conflict} onClick={() => void save()}>Review speichern</button></fieldset>
    </section>
    <details className="operations-card"><summary>Redigierter technischer Originalbeleg</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify({ signal: current.signal.executable, plan: current.plan }, null, 2)}</pre></details>
  </div>;
}
