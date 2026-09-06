import { useEffect, useMemo, useState } from 'react';
type LogEntry = { cursor: number; line: string };
export function useLogSearch(entries: LogEntry[], pattern: string, regex: boolean) {
  const [result, setResult] = useState<{ entries: LogEntry[]; pattern: string; cursors?: number[]; error?: string } | null>(null);
  useEffect(() => {
    if (!regex || !pattern) return;
    let worker: Worker | undefined; let timeout: ReturnType<typeof setTimeout> | undefined;
    const delay = setTimeout(() => {
      const fail = (error: string) => { worker?.terminate(); clearTimeout(timeout); setResult({ entries, pattern, error }); };
      try {
        worker = new Worker(new URL('./log-search.worker.ts', import.meta.url), { type: 'module' });
        timeout = setTimeout(() => fail('Regex-Suche nach 500 ms abgebrochen. Muster vereinfachen oder Textsuche verwenden.'), 500);
        worker.onmessage = event => { clearTimeout(timeout); worker?.terminate(); setResult({ entries, pattern, ...event.data }); };
        worker.onerror = () => fail('Regex-Suche ist im Browser nicht verfügbar. Textsuche bleibt möglich.');
        worker.postMessage({ entries, pattern });
      } catch { fail('Regex-Suche ist im Browser nicht verfügbar. Textsuche bleibt möglich.'); }
    }, 150);
    return () => { clearTimeout(delay); clearTimeout(timeout); worker?.terminate(); };
  }, [entries, pattern, regex]);
  const current = result?.entries === entries && result.pattern === pattern ? result : null;
  const matches = useMemo(() => {
    if (!pattern) return entries;
    if (!regex) { const needle = pattern.toLocaleLowerCase('de-DE'); return entries.filter(entry => entry.line.toLocaleLowerCase('de-DE').includes(needle)); }
    const selected = new Set(current?.cursors ?? []); return entries.filter(entry => selected.has(entry.cursor));
  }, [entries, pattern, regex, current]);
  return { matches, error: regex && pattern ? current?.error : null, searching: regex && Boolean(pattern) && !current };
}
