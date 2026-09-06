import { useCallback, useEffect, useState } from 'react';
import { Link } from '@/lib/navigation';
import { jsonRequest } from '@/lib/api';
import { usePoll } from '@/shared/api/use-poll';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const categories: Record<string, string> = { all: 'Alle Bereiche', accounts: 'Konten', ingress: 'Dauerhafter Eingang', signals: 'Parserergebnisse', intents: 'Intents / Trades', resources: 'Ressourcen', incidents: 'Vorfälle', settings: 'Einstellungen' };
export function GlobalSearch() {
  const [open, setOpen] = useState(false); const [text, setText] = useState(''); const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all'); const [cursor, setCursor] = useState(''); const [state, setState] = useState<any>(null); const [error, setError] = useState('');
  useEffect(() => { const timer = setTimeout(() => { setQuery(text.trim()); setCursor(''); }, 300); return () => clearTimeout(timer); }, [text]);
  const key = JSON.stringify({ open, query, kind, cursor });
  const load = useCallback(async (signal: AbortSignal) => ({ key, result: open && query.length >= 2
    ? await jsonRequest(`/api/ui/search?${new URLSearchParams({ kind, ...(cursor ? { cursor } : {}) })}`, { signal, headers: { 'X-UI-Search': encodeURIComponent(query) } }) : null }), [key, open, query, kind, cursor]);
  usePoll(load, value => { setState(value); setError(''); }, failure => setError(failure.message), 30000);
  const close = () => { setOpen(false); setText(''); setQuery(''); setCursor(''); setKind('all'); setState(null); setError(''); };
  const result = state?.key === key ? state.result : null;
  return <><button className="secondary-button min-h-11" type="button" onClick={() => setOpen(true)}>Global suchen</button>
    <Dialog open={open} onOpenChange={value => value ? setOpen(true) : close()}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>Globale Suche</DialogTitle><DialogDescription>Konten, Objekt-IDs, Symbol, Ressourcenname, Vorfallkategorie oder Einstellungsname. Signalvolltexte und Zugangsdaten werden nicht durchsucht. Der Suchtext bleibt außerhalb von Adresse und Browserhistorie.</DialogDescription></DialogHeader>
      <label>Suchbegriff<input autoFocus type="search" className="block w-full border bg-background p-2" maxLength={80} value={text} onChange={event => setText(event.target.value)} /></label>
      <label>Suchbereich<select className="block border bg-background p-2" value={kind} onChange={event => { setKind(event.target.value); setCursor(''); }}>{Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {error && <p role="alert">{error} · Suche konnte nicht aktuell geprüft werden.</p>}
      {query.length < 2 ? <p>Mindestens zwei Zeichen eingeben.</p> : !result && !error ? <p role="status">Suche läuft …</p> : result?.groups.map((group: any) => <section key={group.kind} aria-label={categories[group.kind]} className="space-y-2"><h3>{categories[group.kind]}</h3>
        {group.entries.length ? <ul className="space-y-2">{group.entries.map((item: any) => <li key={item.id} className="border-b pb-2 break-words"><Link className="underline" to={item.url} onClick={close}>{item.title}</Link><p className="text-sm">{item.subtitle ?? item.id}</p></li>)}</ul> : <p>Keine Treffer für diese Auswahl.</p>}
        <p className="text-xs text-muted-foreground">Beobachtet {new Date(group.observedAt).toLocaleString('de-DE')}</p>
        {group.hasMore && <button type="button" className="secondary-button" onClick={() => { setKind(group.kind); setCursor(group.nextCursor); }}>Weitere Treffer: {categories[group.kind]}</button>}
      </section>)}
      {cursor && <button type="button" className="secondary-button" onClick={() => setCursor('')}>Erste Trefferseite</button>}
    </DialogContent></Dialog></>;
}
