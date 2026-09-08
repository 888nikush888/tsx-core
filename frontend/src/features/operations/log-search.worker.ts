/// <reference lib="webworker" />

type LogEntry = { cursor: number; line: string };
type SearchRequest = { entries: LogEntry[]; pattern: string };
// This module is only created by new Worker(..., { type: 'module' }). Its owner
// communicates over the dedicated worker channel, not Window.postMessage.
const workerScope = self as unknown as DedicatedWorkerGlobalScope;
workerScope.onmessage = (event: MessageEvent<SearchRequest>) => {
  try {
    const { entries, pattern } = event.data;
    if (pattern.length > 200 || entries.length > 5000 || entries.reduce((total, entry) => total + entry.line.length, 0) > 1_000_000) throw new Error('Regex-Suchbudget überschritten (200 Musterzeichen, 5.000 Zeilen, 1 Million Textzeichen). Auswahl vorher verkleinern.');
    const regex = new RegExp(pattern, 'i');
    workerScope.postMessage({ cursors: entries.filter(entry => regex.test(entry.line)).map(entry => entry.cursor) });
  } catch (error_) { workerScope.postMessage({ error: error_ instanceof Error ? error_.message : String(error_) }); }
};
export {};
