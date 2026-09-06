type LogEntry = { cursor: number; line: string };
type SearchRequest = { entries: LogEntry[]; pattern: string };
globalThis.onmessage = (event: MessageEvent<SearchRequest>) => {
  try {
    const { entries, pattern } = event.data;
    if (pattern.length > 200 || entries.length > 5000 || entries.reduce((total, entry) => total + entry.line.length, 0) > 1_000_000) throw new Error('Regex-Suchbudget überschritten (200 Musterzeichen, 5.000 Zeilen, 1 Million Textzeichen). Auswahl vorher verkleinern.');
    const regex = new RegExp(pattern, 'i');
    globalThis.postMessage({ cursors: entries.filter(entry => regex.test(entry.line)).map(entry => entry.cursor) });
  } catch (failure) { globalThis.postMessage({ error: failure instanceof Error ? failure.message : String(failure) }); }
};
export {};
