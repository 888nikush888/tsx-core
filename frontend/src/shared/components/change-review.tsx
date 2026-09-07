import { useMemo, useState } from 'react';

function fields(value: unknown, path = '', result = new Map<string, unknown>()): Map<string, unknown> {
  if (value && typeof value === 'object' && Object.keys(value).length) {
    Object.entries(value).forEach(([key, item]) => fields(item, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, result));
  } else result.set(path || '/', value);
  return result;
}
function display(value: unknown, present: boolean): string {
  if (!present) return 'nicht gesetzt';
  if (value === null) return 'null · kein Wert';
  if (value === '') return 'leere Zeichenkette';
  if (value === true) return 'ja';
  if (value === false) return 'nein';
  return typeof value === 'string' ? value : JSON.stringify(value) ?? 'nicht gesetzt';
}

export function ChangeReview({ before, after, label = 'Inhaltliche Änderungen', showAll = false }: Readonly<{ before?: unknown; after: unknown; label?: string; showAll?: boolean }>) {
  const [filter, setFilter] = useState(''); const [page, setPage] = useState(0);
  const rows = useMemo(() => {
    const left = before === undefined ? new Map<string, unknown>() : fields(before); const right = fields(after);
    return [...new Set([...left.keys(), ...right.keys()])].sort((left, right) => left < right ? -1 : Number(left > right)).map(path => ({ path, left: display(left.get(path), left.has(path)), right: display(right.get(path), right.has(path)),
      changed: left.has(path) !== right.has(path) || JSON.stringify(left.get(path)) !== JSON.stringify(right.get(path)) }))
      .filter(row => (showAll || row.changed) && `${row.path} ${row.left} ${row.right}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  }, [before, after, filter, showAll]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 40) - 1));
  return <section aria-label={label} className="space-y-3"><h3>{label}</h3>
    <label>Feld oder Wert filtern<input className="block border bg-background p-2 w-full" value={filter} onChange={event => { setFilter(event.target.value); setPage(0); }} /></label>
    <p>{rows.length} {showAll || before === undefined ? 'Felder' : 'abweichende Felder'} · Filter bleibt ausschließlich in dieser Ansicht.</p>
    <section className="overflow-x-auto" tabIndex={0} aria-label={`${label}: Tabelleninhalt`}><table className="w-full text-sm"><caption className="sr-only">{label}</caption><thead><tr><th scope="col">Feld</th>{before !== undefined && <th scope="col">Vorher</th>}<th scope="col">{before === undefined ? 'Inhalt' : 'Beantragt'}</th></tr></thead>
      <tbody>{rows.slice(currentPage * 40, (currentPage + 1) * 40).map(row => <tr key={row.path}><th scope="row" className="max-w-64 break-all border-b p-2 text-left">{row.path}</th>{before !== undefined && <td className="max-w-96 whitespace-pre-wrap break-all border-b p-2 align-top">{row.left}</td>}<td className="max-w-96 whitespace-pre-wrap break-all border-b p-2 align-top">{row.right}</td></tr>)}</tbody></table></section>
    {!rows.length && <p>Keine abweichenden Felder für diesen Filter.</p>}
    {rows.length > 40 && <div className="flex gap-3 items-center"><button type="button" className="secondary-button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Vorige Felder</button><span>Seite {currentPage + 1} / {Math.ceil(rows.length / 40)}</span><button type="button" className="secondary-button" disabled={(currentPage + 1) * 40 >= rows.length} onClick={() => setPage(currentPage + 1)}>Weitere Felder</button></div>}
  </section>;
}
