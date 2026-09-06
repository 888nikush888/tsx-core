import { useState } from 'react';
import { jsonRequest } from '@/lib/api';
import { useOperatorReadOnly } from '@/shared/api/operator-session';
import { useConfirmationDialog } from '@/components/confirmation-dialog';

export function RiskAcknowledgment({ id, acknowledgedAt }: { id: string; acknowledgedAt: number | null }) {
  const readOnly = useOperatorReadOnly(); const { confirm, confirmationDialog } = useConfirmationDialog();
  const [busy, setBusy] = useState(false); const [accepted, setAccepted] = useState(false); const [message, setMessage] = useState('');
  const acknowledge = async () => {
    if (readOnly || busy || accepted || acknowledgedAt) return;
    if (!await confirm({ title: 'Risikoereignis quittieren', description: `Ereignis ${id} als gesehen markieren. Die Ursache, Kontosperre und Schutzlage werden dadurch nicht behoben.`, confirmLabel: 'Als gesehen quittieren' })) return;
    setBusy(true); setMessage('');
    try { await jsonRequest('/api/trading/risk/acknowledge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); setAccepted(true); setMessage('Quittierung bestätigt; Ursache separat prüfen.'); }
    catch (error) { setMessage(`Quittierung nicht bestätigt; keine automatische Wiederholung. ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  };
  return <div>{confirmationDialog}{acknowledgedAt ? <span>Quittiert · {new Date(acknowledgedAt).toLocaleString('de-DE')}</span> : <button className="secondary-button" disabled={readOnly || busy || accepted} onClick={() => void acknowledge()}>Quittierung prüfen</button>}{message && <p role="status">{message}</p>}</div>;
}
