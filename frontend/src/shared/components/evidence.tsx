import { isValidElement, type ReactNode } from "react";

export function EvidenceFields({ fields }: { fields: Array<[string, ReactNode]> }) {
  return <dl className="grid gap-3 sm:grid-cols-2">{fields.map(([label, value]) => <div key={label} className="min-w-0 break-words"><dt className="text-sm text-muted-foreground">{label}</dt><dd>{value === null || value === undefined ? "nicht verfügbar" : value === "" ? 'leer' : typeof value === 'boolean' ? value ? 'ja' : 'nein' : value}</dd></div>)}</dl>;
}
export function EvidenceTable({ caption, rows, columns }: { caption: string; rows: Array<Record<string, any>>; columns: Array<[string, string]> }) {
  return <div className="overflow-x-auto" tabIndex={0} role="group" aria-label={`Tabellenbereich: ${caption}`}><table className="w-full text-left"><caption className="text-left py-3">{caption}</caption><thead><tr>{columns.map(([key, label]) => <th scope="col" className="p-2" key={key}>{label}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={typeof row.id === 'string' ? row.id : index}>{columns.map(([key]) => <td className="p-2 break-words" key={key}>{row[key] == null ? "nicht verfügbar" : typeof row[key] === "boolean" ? row[key] ? "ja" : "nein" : isValidElement(row[key]) ? row[key] : String(row[key])}</td>)}</tr>)}</tbody></table>{!rows.length && <p>Keine belegten Einträge.</p>}</div>;
}
