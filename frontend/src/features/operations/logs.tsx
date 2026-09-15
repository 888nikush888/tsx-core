import { usePoll } from '@/shared/api/use-poll';
import { useLogSearch } from './use-log-search';
import { Empty } from "@/shared/components/operator-primitives";
import { useCallback, useEffect, useRef, useState } from "react";
import { jsonRequest } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function Logs() {
  const [entries, setEntries] = useState<
    Array<{ cursor: number; line: string }>
  >([]);
  const cursor = useRef(0);
  const instance = useRef<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [search, setSearch] = useState("");
  const [regexMode, setRegexMode] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copyMessage, setCopyMessage] = useState("");
  const logView = useRef<HTMLDivElement | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [observedAt, setObservedAt] = useState<number | null>(null);
  const [gap, setGap] = useState(false);
  const read = useCallback((signal: AbortSignal) => paused ? Promise.resolve(null) : jsonRequest(`/api/logs?after=${cursor.current}&limit=1000`, { signal }), [paused]);
  usePoll(read, payload => {
    if (!payload) return;
    if (instance.current && payload.serverInstanceId && instance.current !== payload.serverInstanceId) {
      instance.current = payload.serverInstanceId; cursor.current = 0; setEntries([]); setGap(true); return;
    }
    if (payload.serverInstanceId) instance.current = payload.serverInstanceId;
    const incoming = payload.entries || [];
    if (incoming.length) setEntries(previous => {
      const newRows = incoming.filter((entry: { cursor: number }) => !previous.some(existing => existing.cursor === entry.cursor));
      return newRows.length ? [...previous, ...newRows].slice(-5000) : previous;
    });
    cursor.current = payload.nextCursor ?? cursor.current;
    if (payload.dropped) setGap(true);
    setObservedAt(Date.now()); setConnectionError('');
  }, failure => setConnectionError(failure.message), 1000);
  const { matches, error: searchError, searching } = useLogSearch(entries, search, regexMode);
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
  const connectionStatus = () => {
    if (paused) {
      return 'Aktualisierung pausiert';
    }
    if (connectionError) {
      return 'Verbindung gestört';
    }
    if (observedAt) {
      return 'Verbunden';
    }
    return 'Verbindung wird geprüft';
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
        <Button type="button" variant="outline" size="sm" onClick={() => { copy(visibleEntries, "Sichtbare Treffer"); }}>Sichtbare kopieren</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => { copy(matches, "Alle Treffer"); }}>Alle Treffer kopieren</Button>
      </section>
      <p><output>{connectionStatus()} · Letzte erfolgreiche Beobachtung: {observedAt ? new Date(observedAt).toLocaleString('de-DE') : 'unbekannt'}. Lokaler Puffer: höchstens 5.000 Zeilen; Anzeige: letzte 1.000 Treffer.</output></p>
      {connectionError && <p role="alert">{connectionError} Gespeicherte Zeilen bleiben lesbar.</p>}
      {gap && <p role="alert">Der Server meldet eine Cursorlücke. Die angezeigten Logs sind nicht vollständig.</p>}
      {regexMode && <p>Regex läuft in einem getrennten Suchprozess mit 500 ms Zeitlimit. Zu große oder zu langsame Suchen werden abgebrochen.</p>}
      {searchError && <p role="alert">{searchError}</p>}{searching && <p><output>Begrenzte Suche läuft …</output></p>}
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
