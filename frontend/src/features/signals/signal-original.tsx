import { useCallback, useState } from 'react';
import { jsonRequest } from '@/lib/api';
import { Link, useSearchParams } from '@/lib/navigation';
import { usePoll } from '@/shared/api/use-poll';
import { useOperatorReadOnly } from '@/shared/api/operator-session';
import { useConfirmationDialog } from '@/components/confirmation-dialog';
import { EvidenceFields } from '@/shared/components/evidence';

export function DeleteStoredSignal({ id, kind, onDeleted }: { id: string | number; kind: 'messages' | 'processed'; onDeleted?: () => void }) {
  const readOnly = useOperatorReadOnly(); const { confirm, confirmationDialog } = useConfirmationDialog();
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [deleted, setDeleted] = useState(false);
  const remove = async () => {
    if (readOnly || busy || deleted) return;
    if (!await confirm({ title: 'Gespeichertes Original löschen', destructive: true, confirmationText: String(id), confirmLabel: 'Dieses Original löschen',
      description: kind === 'messages' ? `Nachricht ${id} aus dem Nachrichtenspeicher entfernen. Dauerhafter Eingang, Trades und Versandaufträge werden dadurch nicht gelöscht oder abgebrochen.`
        : `Parserergebnis ${id} dauerhaft entfernen. Der Server lehnt die Löschung ab, wenn Handelsreferenzen bestehen. Laufende Verarbeitung wird dadurch nicht abgebrochen.` })) return;
    setBusy(true); setMessage('');
    try {
      await jsonRequest(`/api/${kind === 'messages' ? 'incoming-messages' : 'processed-signals'}?id=${encodeURIComponent(id)}`, {
        method: 'DELETE', headers: { 'X-Destructive-Confirmation': kind === 'messages' ? 'delete-incoming-message' : 'delete-processed-signal' },
      });
      setDeleted(true); setMessage(`Löschung von ${id} bestätigt.`); onDeleted?.();
    } catch (error) { setMessage(`Löschung nicht bestätigt; keine automatische Wiederholung. ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  };
  return <div>{confirmationDialog}<button className="danger-button" disabled={readOnly || busy || deleted} onClick={() => void remove()}>Gespeichertes Original löschen</button>
    {readOnly && <p>Löschung erfordert die Administratorrolle.</p>}{message && <p role="status">{message}</p>}</div>;
}

export function SignalOriginal({ id, kind }: { id: string; kind: 'messages' | 'processed' }) {
  const [params, setParams] = useSearchParams(); const field = params.get('field') || (kind === 'messages' ? 'text' : 'xml');
  const cursor = params.get('textCursor') || ''; const query = new URLSearchParams({ id, kind, field, cursor }).toString();
  const [state, setState] = useState<any>(null); const [error, setError] = useState(''); const [deleted, setDeleted] = useState(false);
  const read = useCallback((signal: AbortSignal) => jsonRequest(`/api/signals/original?${query}`, { signal }), [query]);
  usePoll(read, value => { setState({ query, value }); setError(''); }, failure => setError(failure.message));
  const data = state?.query === query ? state.value : null;
  const select = (nextField: string, nextCursor?: string) => setParams(previous => { previous.set('field', nextField); if (nextCursor) previous.set('textCursor', nextCursor); else previous.delete('textCursor'); return previous; });
  return <div className="operations-stack"><Link to={kind === 'messages' ? '/signals/cache' : '/signals/processed'}>Zur Liste</Link><h1>Gespeichertes Original {id}</h1>
    <DeleteStoredSignal id={id} kind={kind} onDeleted={() => setDeleted(true)} />
    {error && !deleted && <p role="alert">{error} · Vorhandener Abschnitt möglicherweise veraltet.</p>}
    {deleted ? <p>Das bestätigte Löschergebnis bleibt erhalten. Bereits gelesene Textabschnitte werden ausgeblendet.</p> : <>
      {kind === 'processed' && <label>Originalfeld<select className="border bg-background p-2" value={field} onChange={event => select(event.target.value)}><option value="xml">Parserantwort (XML)</option><option value="normalized">Gespeicherte Normalisierung</option></select></label>}
      {data ? <section className="operations-card space-y-4"><EvidenceFields fields={[["Kanal / Nachricht", `${data.channelId} / ${data.messageId}`], ['Modell', data.model], ['Vorlage', data.templateName], ['Schema', data.schemaName], ['Prompthash', data.promptSha256], ['Parser', data.parserVersion], ['Originalrevision', data.workflowRevisionId], ['Gespeichert', new Date(data.createdAt).toLocaleString('de-DE')]]} />
        <p>{data.interpretation}</p><p>Abschnitt ab Zeichen {data.offset + 1} · insgesamt {data.totalCharacters ?? 'unbekannt'} Zeichen vor Redigierung</p>
        {data.channelId != null && data.messageId != null && <Link to={`/signals/messages?channelId=${encodeURIComponent(data.channelId)}&messageId=${encodeURIComponent(data.messageId)}`}>Eingangsspur dieser Originalnachricht öffnen</Link>}
        <pre aria-label="Originaltext" className="whitespace-pre-wrap break-all max-h-96 overflow-auto border p-3">{data.text ?? 'Kein gespeicherter Text vorhanden.'}</pre>
        <div className="flex gap-3"><button className="secondary-button" disabled={!cursor} onClick={() => select(field)}>Erster Textabschnitt</button><button className="secondary-button" disabled={!data.hasMore} onClick={() => select(field, data.nextCursor)}>Weiterer Textabschnitt</button></div>
        {data.workflowRevisionId && <Link to={`/workflows/revisions/${encodeURIComponent(data.workflowRevisionId)}`}>Originalrevision öffnen</Link>}
      </section> : <p role="status">Original wird geladen …</p>}</>}
  </div>;
}
