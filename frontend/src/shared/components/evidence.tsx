import { isValidElement, type ReactNode } from "react";

function evidenceFieldValue(value: ReactNode): ReactNode {
  if (value === null || value === undefined) return "nicht verfügbar";
  if (value === "") return "leer";
  if (typeof value === "boolean") return value ? "ja" : "nein";
  return value;
}

function evidenceCellValue(value: any): ReactNode {
  if (value == null) return "nicht verfügbar";
  if (typeof value === "boolean") return value ? "ja" : "nein";
  if (isValidElement(value)) return value;
  return String(value);
}

export function EvidenceFields({ fields }: Readonly<{ fields: Array<[string, ReactNode]> }>) {
  return <dl className="grid gap-3 sm:grid-cols-2">{fields.map(([label, value]) =>
    <div key={label} className="min-w-0 break-words"><dt className="text-sm text-muted-foreground">{label}</dt><dd>{evidenceFieldValue(value)}</dd></div>
  )}</dl>;
}

export function EvidenceTable({ caption, rows, columns }: Readonly<{ caption: string; rows: Array<Record<string, any>>; columns: Array<[string, string]> }>) {
  return <section className="overflow-x-auto" tabIndex={0} aria-label={`Tabellenbereich: ${caption}`}>
    <table className="w-full text-left">
      <caption className="text-left py-3">{caption}</caption>
      <thead><tr>{columns.map(([key, label]) => <th scope="col" className="p-2" key={key}>{label}</th>)}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={typeof row.id === 'string' ? row.id : index}>
        {columns.map(([key]) => <td className="p-2 break-words" key={key}>{evidenceCellValue(row[key])}</td>)}
      </tr>)}</tbody>
    </table>
    {!rows.length && <p>Keine belegten Einträge.</p>}
  </section>;
}
