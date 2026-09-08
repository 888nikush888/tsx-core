import { useCallback, useState } from 'react';
import { jsonRequest } from '@/lib/api';
import { usePoll } from '@/shared/api/use-poll';
import { EvidenceTable } from '@/shared/components/evidence';

export function SetupReviewTree({ previewKey }: Readonly<{ previewKey: string }>) {
  const [side, setSide] = useState('before'); const [path, setPath] = useState<string[]>([]); const [cursor, setCursor] = useState('');
  const query = new URLSearchParams({ key: previewKey, side, path: JSON.stringify(path), cursor }).toString();
  const [state, setState] = useState<any>(null); const [error, setError] = useState('');
  const read = useCallback((signal: AbortSignal) => jsonRequest(`/api/setup-bundle/review?${query}`, { signal }), [query]);
  usePoll(read, value => { setState({ query, value }); setError(''); }, failure => setError(failure.message), 30000);
  const data = state?.query === query ? state.value : null;
  const open = (nextPath: string[]) => { setPath(nextPath); setCursor(''); };
  return <section className="space-y-4" aria-label="Vollständiger Setup-Prüfbestand"><h3>Vollständige Inhalte abschnittsweise prüfen</h3>
    <label>Prüfseite<select className="border bg-background p-2" value={side} onChange={event => { setSide(event.target.value); open([]); }}><option value="before">Vorhandenes Setup</option><option value="after">Angefordertes Setup</option><option value="library">Bestehende Bibliothek einschließlich Entwürfe</option></select></label>
    <p>{path.length ? path.join(' → ') : 'Wurzel des Prüfbestands'}</p><button className="secondary-button" disabled={!path.length} onClick={() => open(path.slice(0, -1))}>Eine Ebene zurück</button>
    {error && <p role="alert">{error} · Geänderte oder abgelaufene Vorschau muss erneut erstellt werden.</p>}
    {data ? <>{data.type === 'string' ? <pre className="whitespace-pre-wrap break-all border p-3 max-h-96 overflow-auto">{data.text}</pre> : <EvidenceTable caption="Originalwerte dieser Ebene" columns={[["key", "Feld / Objekt"], ["type", "Datentyp"], ["value", "Gespeicherter Wert / Anfang"], ["childCount", "Unterwerte"], ["open", "Inhalt öffnen"]]} rows={data.entries.map((entry: any) => ({ ...entry, value: entry.type === 'null' ? 'null' : entry.value,
      open: entry.expandable ? <button className="secondary-button" onClick={() => open(entry.path)}>{entry.key} vollständig öffnen</button> : 'vollständig angezeigt' }))} />}
      {!data.entries.length && data.type !== 'string' && <p>Wert: {JSON.stringify(data.value ?? null)}</p>}
      <div className="flex gap-3"><button className="secondary-button" disabled={!cursor} onClick={() => setCursor('')}>Erster Prüfabschnitt</button><button className="secondary-button" disabled={!data.hasMore} onClick={() => setCursor(data.nextCursor)}>Weitere Prüfwerte</button></div>
    </> : !error && <p><output>Prüfabschnitt wird gelesen …</output></p>}
  </section>;
}
