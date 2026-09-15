import { useCallback, useState } from "react";
import { apiFetch, jsonRequest, mutateAndObserve } from "@/lib/api";
import { Link, useSearchParams } from "@/lib/navigation";
import { usePoll } from "@/shared/api/use-poll";
import { JOURNAL_INTENT_STATUSES } from "../../../../src/ui_contracts";
import { MoneyAmount, MoneySummaryAmount } from "@/app/workflow/money-amount";
import type { TradingSnapshot } from "@/app/workflow/types";
import { buildJournalQueryString } from "./query";
import { useOperatorReadOnly } from "@/shared/api/operator-session";
import { AccountFilter } from '@/features/accounts/account-filter';

const FILTER_KEYS = ["from", "to", "channelId", "accountId", "symbol", "status", "reviewed"] as const;
export function JournalPage({ trading, onRefresh }: Readonly<{ trading: TradingSnapshot | null; onRefresh: () => Promise<void> }>) {
  const readOnly = useOperatorReadOnly();
  const [params, setParams] = useSearchParams();
  const filters = Object.fromEntries(FILTER_KEYS.map((key) => [key, params.get(key) ?? ""])) as Record<typeof FILTER_KEYS[number], string>;
  const cursor = params.get("cursor") ?? "";
  const baseQuery = buildJournalQueryString(filters);
  const query = baseQuery + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
  const [page, setPage] = useState<any>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const read = useCallback(async (signal: AbortSignal) => ({ query, payload: await jsonRequest(`/api/trading/journal?${query}&view=summary`, { signal }) }), [query]);
  usePoll(read, (value) => { setPage(value); setError(""); }, (reason) => setError(reason.message), 5000, refresh);
  const current = page?.query === query ? page.payload : null;
  const setFilter = (key: string, value: string) => setParams((previous) => {
    if (value) { previous.set(key, value); } else { previous.delete(key); } previous.delete("cursor"); return previous;
  }, { replace: true });
  const exportPage = async (format: "csv" | "json") => {
    try {
      const response = await apiFetch(`/api/trading/journal/export?${query}&format=${format}`);
      if (!response.ok) throw new Error(`Export fehlgeschlagen (${response.status}).`);
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a"); anchor.href = url;
      anchor.download = `tsx-core-journal-seite-${new Date().toISOString().slice(0, 10)}.${format}`;
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("Aktuelle Seite mit denselben Filtern exportiert. Spätere Status-/Reviewänderungen können im Export bereits enthalten sein.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const acknowledge = async (id: string) => {
    if (readOnly) return;
    try {
      const { refreshError } = await mutateAndObserve(() => jsonRequest("/api/trading/risk/acknowledge", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
      }), () => setNotice("Risikoereignis quittiert. Die Ursache und Schutzlage werden dadurch nicht behoben."), onRefresh);
      if (refreshError) setError(`Quittierung bestätigt; Nachladen fehlgeschlagen: ${refreshError}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const journalPageSummary = () => {
    if (current) {
      return `${current.entries.length} Einträge auf dieser Seite · ${current.hasMore ? "weitere vorhanden" : "Ende der Auswahl"}`;
    }
    return "Auswahl wird geladen …";
  };
  return <div className="operations-stack">
    <div className="operations-section-heading"><div><h2>Trade Journal</h2><p>Originalversionen, Ausführungsdaten und Reviews. {journalPageSummary()}</p></div>
      <div className="system-actions"><button className="secondary-button" onClick={() => { exportPage("csv"); }}>CSV · aktuelle Seite</button><button className="secondary-button" onClick={() => { exportPage("json"); }}>JSON · aktuelle Seite</button><button className="secondary-button" onClick={() => setRefresh((value) => value + 1)}>Aktualisieren</button></div></div>
    <section className="operations-card journal-filterbar" aria-label="Journalfilter">
      <label>Von<input type="date" value={filters.from} onChange={(event) => setFilter("from", event.target.value)} /></label>
      <label>Bis<input type="date" value={filters.to} onChange={(event) => setFilter("to", event.target.value)} /></label>
      <label>Kanal<input value={filters.channelId} onChange={(event) => setFilter("channelId", event.target.value)} /></label>
      <AccountFilter value={filters.accountId} onChange={value => setFilter('accountId', value)} />
      <label>Symbol<input value={filters.symbol} onChange={(event) => setFilter("symbol", event.target.value)} placeholder="BTCUSDT" /></label>
      <label>Intentstatus<select value={filters.status} onChange={(event) => setFilter("status", event.target.value)}><option value="">Alle Status</option>{JOURNAL_INTENT_STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label>
      <label>Review<select value={filters.reviewed} onChange={(event) => setFilter("reviewed", event.target.value)}><option value="">Alle Reviews</option><option value="true">Geprüft</option><option value="false">Nicht geprüft</option></select></label>
      <button className="secondary-button" onClick={() => setParams(new URLSearchParams())}>Filter zurücksetzen</button>
    </section>
    {error && <p role="alert" className="builder-error">{error} Vorhandene Daten können veraltet sein.</p>}{notice && <p><output>{notice}</output></p>}
    {current && <><p>Erstellungsgrenze: {current.observedAt ? new Date(current.observedAt).toLocaleString("de-DE") : "unbekannt"}. Status, Review und Geldbewertung entsprechen der jeweiligen Seitenabfrage.</p>
      <div className="overflow-x-auto"><table className="w-full text-left"><caption className="sr-only">Journal · serverseitig paginierte Auswahl</caption><thead><tr>{["Trade", "Konto / Modus", "Intentstatus", "Erstellt", "Geldbewertung", "Review"].map((label) => <th scope="col" key={label} className="p-3">{label}</th>)}</tr></thead>
        <tbody>{current.entries.map((entry: any) => <tr key={entry.intentId}><td className="p-3"><Link to={`/trading/trades/${encodeURIComponent(entry.intentId)}`}>{entry.symbol} · {entry.side}</Link></td><td className="p-3">{entry.accountName} · {entry.exchange} / {entry.mode}</td><td className="p-3">{entry.status}</td><td className="p-3">{new Date(entry.createdAt).toLocaleString("de-DE")}</td><td className="p-3">{entry.money ? <MoneySummaryAmount summary={entry.money} /> : <MoneyAmount value={entry.position?.realizedPnlValue} amount={entry.position?.realizedPnl} currency={entry.position?.reportingCurrency} status={entry.position?.accountingStatus} />}</td><td className="p-3">{entry.review?.reviewed ? "geprüft" : "nicht geprüft"} · {entry.review?.rating ?? "keine Bewertung"}</td></tr>)}</tbody></table></div>
      {!current.entries.length && <p>Keine Einträge für diese Filter.</p>}
      <div className="system-actions"><button className="secondary-button" disabled={!cursor} onClick={() => setParams((previous) => { previous.delete("cursor"); return previous; })}>Erste Seite</button><button className="secondary-button" disabled={!current.hasMore} onClick={() => setParams((previous) => { previous.set("cursor", current.nextCursor); return previous; })}>Nächste Seite</button></div></>}
    <section className="operations-card"><h3>Risikoereignisse · aktueller Ausschnitt</h3><Link to="/trading/risk-events?status=unacknowledged">Alle unquittierten Risikoereignisse seitenweise prüfen</Link>{(trading?.activity.riskEvents ?? []).map((event: any) => <div className="system-line" key={event.id}><span>{event.code} · {event.accountId ?? "global"}</span>{event.acknowledgedAt ? <span>Quittiert · Ursache separat prüfen</span> : <button className="secondary-button" disabled={readOnly} onClick={() => { acknowledge(event.id); }}>Quittieren</button>}</div>)}</section>
  </div>;
}
